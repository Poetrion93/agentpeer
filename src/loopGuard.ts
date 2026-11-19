import { matchesAutoNotice } from "./notices.ts";
import type { Store } from "./db.ts";
import { headerValue } from "./normalize.ts";
import {
  MAX_HOP,
  RATE_SENDER_LIMIT,
  RATE_THREAD_LIMIT,
  RATE_WINDOW_MS,
  type MessageStatus,
  type NormalizedMessage,
} from "./types.ts";

export interface LoopDecision {
  block: boolean;
  status?: Extract<MessageStatus, "blocked_loop" | "blocked_autonotice">;
  reason?: string;
}

export function parseHop(headers: Record<string, string>): number {
  const raw =
    headerValue(headers, "x-agentpeer-hop") || headerValue(headers, "x-bot-mail-hop") || "0";
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function inspectHeaders(msg: NormalizedMessage, loopToken: string): LoopDecision {
  const h = msg.headers;
  const auto = headerValue(h, "auto-submitted").trim();
  if (auto && auto.toLowerCase() !== "no") {
    return { block: true, status: "blocked_autonotice", reason: `auto-submitted: ${auto}` };
  }

  const loop = headerValue(h, "x-loop");
  if (loopToken && loop.toLowerCase().includes(loopToken.toLowerCase())) {
    return { block: true, status: "blocked_loop", reason: "x-loop token" };
  }

  const prec = headerValue(h, "precedence").toLowerCase();
  if (prec === "bulk" || prec === "auto_reply" || prec === "junk") {
    return { block: true, status: "blocked_autonotice", reason: `precedence: ${prec}` };
  }

  if (headerValue(h, "x-autoreply")) {
    return { block: true, status: "blocked_autonotice", reason: "x-autoreply" };
  }
  if (headerValue(h, "x-auto-response-suppress")) {
    return { block: true, status: "blocked_autonotice", reason: "x-auto-response-suppress" };
  }
  if (headerValue(h, "list-id")) {
    return { block: true, status: "blocked_autonotice", reason: "list-id" };
  }

  const returnPath = headerValue(h, "return-path").trim();
  if (returnPath === "<>") {
    return { block: true, status: "blocked_autonotice", reason: "empty return-path" };
  }

  const from = msg.from.addr.toLowerCase();
  const local = from.split("@")[0] ?? "";
  if (local === "mailer-daemon" || local === "postmaster") {
    return { block: true, status: "blocked_autonotice", reason: `system sender: ${from}` };
  }

  const notice = matchesAutoNotice(msg.subject, msg.text);
  if (notice) {
    return { block: true, status: "blocked_autonotice", reason: `auto-notice pattern: ${notice}` };
  }

  const hop = parseHop(h);
  if (hop > MAX_HOP) {
    return { block: true, status: "blocked_loop", reason: `hop ${hop} > ${MAX_HOP}` };
  }

  return { block: false };
}

/**
 * Rate breaker: same (from, recipient, thread) 5 / 10 min,
 * or same sender 30 / 10 min, blocks and writes an event.
 * Counts already-stored messages in the window (the current row is included).
 */
export async function inspectRate(
  store: Store,
  msg: NormalizedMessage,
): Promise<LoopDecision> {
  const since = msg.receivedAt - RATE_WINDOW_MS;
  const threadCount = await store.countThreadWindow({
    threadId: msg.threadId,
    fromAddr: msg.from.addr,
    recipient: msg.recipient,
    since,
  });
  if (threadCount > RATE_THREAD_LIMIT) {
    return {
      block: true,
      status: "blocked_loop",
      reason: `rate breaker: ${threadCount} in thread window (limit ${RATE_THREAD_LIMIT}/10m)`,
    };
  }
  const senderCount = await store.countSenderWindow({ fromAddr: msg.from.addr, since });
  if (senderCount > RATE_SENDER_LIMIT) {
    return {
      block: true,
      status: "blocked_loop",
      reason: `rate breaker: ${senderCount} from sender in 10m (limit ${RATE_SENDER_LIMIT})`,
    };
  }
  return { block: false };
}

export async function loopGuard(
  store: Store,
  msg: NormalizedMessage,
  loopToken: string,
): Promise<LoopDecision> {
  const header = inspectHeaders(msg, loopToken);
  if (header.block) return header;
  return inspectRate(store, msg);
}
