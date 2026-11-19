import { getAdapter, type AdapterContext } from "./adapters/index.ts";
import type { Store } from "./db.ts";
import { dedupKey } from "./dedup.ts";
import { loopGuard, parseHop } from "./loopGuard.ts";
import { headersSubset, normalize, recipientsFromPayload } from "./normalize.ts";
import { matchRoute } from "./router.ts";
import { checkTrust } from "./trust.ts";
import type {
  EnvBindings,
  MessageRow,
  MessageStatus,
  NormalizedMessage,
  ProcessResult,
  RouteRule,
} from "./types.ts";

export interface PipelineDeps {
  store: Store;
  routes: RouteRule[];
  env: EnvBindings;
  now?: number;
  fetch?: typeof fetch;
  consoleUrl?: string;
  loopToken?: string;
  tenantId?: string;
  /** When false (default), [TEST] subjects are stored but not delivered. */
  deliverTest?: boolean;
}

function newId(): string {
  return crypto.randomUUID();
}

function toRow(
  id: string,
  msg: NormalizedMessage,
  key: string,
  status: MessageStatus,
): MessageRow {
  return {
    id,
    tenant_id: msg.tenantId,
    channel: msg.channel,
    source: msg.source,
    message_id: msg.messageId,
    thread_id: msg.threadId,
    from_addr: msg.from.addr,
    from_name: msg.from.name,
    recipients_json: JSON.stringify(msg.to),
    recipient: msg.recipient,
    kind: msg.kind,
    auth_json: JSON.stringify(msg.auth),
    subject: msg.subject,
    text: msg.text,
    raw_ref: msg.rawRef,
    attachments_meta_json: JSON.stringify(msg.attachmentsMeta),
    headers_subset_json: JSON.stringify(headersSubset(msg.headers)),
    received_at: msg.receivedAt,
    status,
    route_id: null,
    dedup_key: key,
  };
}

async function record(
  store: Store,
  messageId: string | null,
  type: string,
  detail: string,
  at: number,
): Promise<void> {
  await store.insertEvent({ message_id: messageId, type, detail, at });
}

export async function processOne(
  payload: unknown,
  recipient: string,
  deps: PipelineDeps,
): Promise<ProcessResult> {
  const now = deps.now ?? Date.now();
  const tenantId = deps.tenantId ?? "ounce";
  const loopToken = deps.loopToken ?? "agentpeer";
  const msg = normalize(payload, recipient, now, tenantId);
  const key = await dedupKey(msg);
  const id = newId();
  const row = toRow(id, msg, key, "received");
  const insert = await deps.store.insertMessage(row);
  if (insert === "duplicate") {
    const existing = await deps.store.getByDedupKey(key);
    await record(deps.store, existing?.id ?? id, "duplicate", `dedup_key ${key}`, now);
    return { id: existing?.id ?? id, recipient: msg.recipient, status: "duplicate", reason: "dedup" };
  }

  const loop = await loopGuard(deps.store, msg, loopToken);
  if (loop.block && loop.status) {
    await deps.store.updateMessage(id, { status: loop.status });
    await record(deps.store, id, loop.status, loop.reason ?? "blocked", now);
    return { id, recipient: msg.recipient, status: loop.status, reason: loop.reason };
  }

  const route = matchRoute(deps.routes, msg.recipient);
  const trust = checkTrust(msg.from.addr, route);
  if (!trust.allowed) {
    await deps.store.updateMessage(id, { status: "blocked_auth", route_id: route?.id ?? null });
    await record(deps.store, id, "blocked_auth", trust.reason ?? "allowlist", now);
    return { id, recipient: msg.recipient, status: "blocked_auth", reason: trust.reason, routeId: route?.id };
  }

  if (msg.kind === "test" && !deps.deliverTest) {
    await deps.store.updateMessage(id, { status: "received", route_id: route?.id ?? null });
    await record(deps.store, id, "test_held", "deliver_test=false", now);
    return { id, recipient: msg.recipient, status: "received", reason: "test held", routeId: route?.id };
  }

  if (!route) {
    await deps.store.updateMessage(id, { status: "delivered", route_id: null });
    await record(deps.store, id, "unrouted", "no route; stored only", now);
    return { id, recipient: msg.recipient, status: "delivered", reason: "unrouted store_only" };
  }

  if (route.type === "drop") {
    await deps.store.updateMessage(id, { status: "delivered", route_id: route.id });
    await record(deps.store, id, "drop", "route type drop", now);
    return { id, recipient: msg.recipient, status: "delivered", reason: "drop", routeId: route.id };
  }

  await deps.store.updateMessage(id, { status: "routed", route_id: route.id });
  return deliver(id, msg, route, deps, now);
}

export async function deliver(
  id: string,
  msg: NormalizedMessage,
  route: RouteRule,
  deps: PipelineDeps,
  now: number,
  attempt = 1,
): Promise<ProcessResult> {
  const adapter = getAdapter(route.type);
  if (!adapter) {
    await deps.store.updateMessage(id, { status: "failed", route_id: route.id });
    await record(deps.store, id, "failed", `no adapter for ${route.type}`, now);
    return { id, recipient: msg.recipient, status: "failed", reason: "no adapter", routeId: route.id };
  }
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(deps.env)) {
    if (typeof v === "string") env[k] = v;
  }
  const ctx: AdapterContext = {
    fetch: deps.fetch ?? fetch,
    env,
    now,
    consoleUrl: deps.consoleUrl,
    nextHop: parseHop(msg.headers) + 1,
    loopToken: deps.loopToken ?? "agentpeer",
  };
  const result = await adapter.deliver(id, msg, route, ctx);
  await deps.store.insertDelivery({
    message_id: id,
    target: route.target ?? null,
    adapter: route.type,
    attempt,
    http_status: result.httpStatus ?? null,
    error: result.error ?? null,
    at: now,
  });
  if (result.ok) {
    await deps.store.updateMessage(id, { status: "delivered", route_id: route.id });
    await record(deps.store, id, "delivered", route.type, now);
    return { id, recipient: msg.recipient, status: "delivered", routeId: route.id };
  }
  await deps.store.updateMessage(id, { status: "failed", route_id: route.id });
  await record(deps.store, id, "delivery_failed", result.error ?? "delivery failed", now);
  return {
    id,
    recipient: msg.recipient,
    status: "failed",
    reason: result.error,
    routeId: route.id,
  };
}

/**
 * Ingest a Forward Email webhook. Always returns HTTP 200 after a successful store.
 * Each recipient is judged separately (FE may batch them).
 */
export async function ingestForwardEmail(
  payload: unknown,
  deps: PipelineDeps,
): Promise<{ httpStatus: 200; results: ProcessResult[] }> {
  const recipients = recipientsFromPayload(payload);
  if (!recipients.length) {
    const now = deps.now ?? Date.now();
    await record(deps.store, null, "no_recipient", "payload had no recipients", now);
    return { httpStatus: 200, results: [] };
  }
  const results: ProcessResult[] = [];
  for (const recipient of recipients) {
    results.push(await processOne(payload, recipient, deps));
  }
  return { httpStatus: 200, results };
}
