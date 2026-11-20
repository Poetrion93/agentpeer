import type { DeliveryRow, EventRow, MessageRow, MessageStatus } from "./types.ts";

export interface Store {
  insertMessage(row: MessageRow): Promise<"inserted" | "duplicate">;
  updateMessage(
    id: string,
    patch: { status: MessageStatus; route_id?: string | null },
  ): Promise<void>;
  getMessage(id: string): Promise<MessageRow | null>;
  getByDedupKey(key: string): Promise<MessageRow | null>;
  countThreadWindow(input: {
    threadId: string;
    fromAddr: string;
    recipient: string;
    since: number;
  }): Promise<number>;
  countSenderWindow(input: { fromAddr: string; since: number }): Promise<number>;
  countPairWindow(input: { fromAddr: string; recipient: string; since: number }): Promise<number>;
  /** blocked-until epoch ms for the pair, or null if never blocked. */
  getPairBlock(input: { fromAddr: string; recipient: string }): Promise<number | null>;
  setPairBlock(input: { fromAddr: string; recipient: string; blockedUntil: number }): Promise<void>;
  insertEvent(row: EventRow): Promise<void>;
  insertDelivery(row: DeliveryRow): Promise<void>;
  listMessages(limit?: number): Promise<MessageRow[]>;
  listEvents(messageId: string): Promise<EventRow[]>;
  listDeliveries(messageId: string): Promise<DeliveryRow[]>;
  listRetryable(now: number, maxAttempts: number): Promise<MessageRow[]>;
}

type Binder = { changes: number };

export interface SqlExec {
  run(sql: string, ...params: unknown[]): Promise<Binder>;
  first<T>(sql: string, ...params: unknown[]): Promise<T | null>;
  all<T>(sql: string, ...params: unknown[]): Promise<T[]>;
}

export function storeFromSql(sql: SqlExec): Store {
  return {
    async insertMessage(row) {
      const result = await sql.run(
        `INSERT OR IGNORE INTO messages (
          id, tenant_id, channel, source, message_id, thread_id,
          from_addr, from_name, recipients_json, recipient, kind, auth_json,
          subject, text, raw_ref, attachments_meta_json, headers_subset_json,
          received_at, status, route_id, dedup_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.tenant_id,
        row.channel,
        row.source,
        row.message_id,
        row.thread_id,
        row.from_addr,
        row.from_name,
        row.recipients_json,
        row.recipient,
        row.kind,
        row.auth_json,
        row.subject,
        row.text,
        row.raw_ref,
        row.attachments_meta_json,
        row.headers_subset_json,
        row.received_at,
        row.status,
        row.route_id,
        row.dedup_key,
      );
      return result.changes === 0 ? "duplicate" : "inserted";
    },

    async updateMessage(id, patch) {
      if (patch.route_id !== undefined) {
        await sql.run(
          `UPDATE messages SET status = ?, route_id = ? WHERE id = ?`,
          patch.status,
          patch.route_id,
          id,
        );
      } else {
        await sql.run(`UPDATE messages SET status = ? WHERE id = ?`, patch.status, id);
      }
    },

    async getMessage(id) {
      return sql.first<MessageRow>(`SELECT * FROM messages WHERE id = ?`, id);
    },

    async getByDedupKey(key) {
      return sql.first<MessageRow>(`SELECT * FROM messages WHERE dedup_key = ?`, key);
    },

    async countThreadWindow({ threadId, fromAddr, recipient, since }) {
      const row = await sql.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM messages
         WHERE thread_id = ? AND from_addr = ? AND recipient = ? AND received_at > ?`,
        threadId,
        fromAddr,
        recipient,
        since,
      );
      return Number(row?.c ?? 0);
    },

    async countSenderWindow({ fromAddr, since }) {
      const row = await sql.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM messages WHERE from_addr = ? AND received_at > ?`,
        fromAddr,
        since,
      );
      return Number(row?.c ?? 0);
    },

    async countPairWindow({ fromAddr, recipient, since }) {
      const row = await sql.first<{ c: number }>(
        `SELECT COUNT(*) AS c FROM messages
         WHERE from_addr = ? AND recipient = ? AND received_at > ?`,
        fromAddr,
        recipient,
        since,
      );
      return Number(row?.c ?? 0);
    },

    async getPairBlock({ fromAddr, recipient }) {
      const row = await sql.first<{ blocked_until: number }>(
        `SELECT blocked_until FROM pair_blocks WHERE from_addr = ? AND recipient = ?`,
        fromAddr,
        recipient,
      );
      return row ? Number(row.blocked_until) : null;
    },

    async setPairBlock({ fromAddr, recipient, blockedUntil }) {
      // events has no from/recipient columns, so "blocked until" needs its own tiny table.
      await sql.run(
        `INSERT INTO pair_blocks (from_addr, recipient, blocked_until) VALUES (?, ?, ?)
         ON CONFLICT(from_addr, recipient) DO UPDATE SET blocked_until = excluded.blocked_until`,
        fromAddr,
        recipient,
        blockedUntil,
      );
    },

    async insertEvent(row) {
      await sql.run(
        `INSERT INTO events (message_id, type, detail, at) VALUES (?, ?, ?, ?)`,
        row.message_id,
        row.type,
        row.detail,
        row.at,
      );
    },

    async insertDelivery(row) {
      await sql.run(
        `INSERT INTO deliveries (message_id, target, adapter, attempt, http_status, error, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.message_id,
        row.target,
        row.adapter,
        row.attempt,
        row.http_status,
        row.error,
        row.at,
      );
    },

    async listMessages(limit = 50) {
      return sql.all<MessageRow>(
        `SELECT * FROM messages ORDER BY received_at DESC LIMIT ?`,
        limit,
      );
    },

    async listEvents(messageId) {
      return sql.all<EventRow>(
        `SELECT * FROM events WHERE message_id = ? ORDER BY at ASC, id ASC`,
        messageId,
      );
    },

    async listDeliveries(messageId) {
      return sql.all<DeliveryRow>(
        `SELECT * FROM deliveries WHERE message_id = ? ORDER BY at ASC, id ASC`,
        messageId,
      );
    },

    async listRetryable(now, maxAttempts) {
      // shortcut: poll failed/routed rows by last delivery time, not a queue.
      // upgrade when volume needs a deliveries-outbox table with next_attempt_at.
      return sql.all<MessageRow>(
        `SELECT m.* FROM messages m
         WHERE m.status IN ('routed', 'failed')
           AND (
             SELECT COUNT(*) FROM deliveries d WHERE d.message_id = m.id
           ) < ?
           AND (
             SELECT COALESCE(MAX(d.at), 0) FROM deliveries d WHERE d.message_id = m.id
           ) <= ?
         ORDER BY m.received_at ASC`,
        maxAttempts,
        now,
      );
    },
  };
}

export function d1Exec(db: D1Database): SqlExec {
  return {
    async run(sql, ...params) {
      const res = await db.prepare(sql).bind(...params).run();
      return { changes: res.meta.changes ?? 0 };
    },
    async first(sql, ...params) {
      const row = await db.prepare(sql).bind(...params).first();
      return (row as never) ?? null;
    },
    async all(sql, ...params) {
      const res = await db.prepare(sql).bind(...params).all();
      return (res.results ?? []) as never;
    },
  };
}
