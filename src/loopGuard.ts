import { matchesHardAutoNotice, matchesSuspectAutoNotice } from "./notices.ts";
import type { Store } from "./db.ts";
import { headerValue } from "./normalize.ts";
import {
  MAX_HOP,
  RATE_BLOCK_MS,
  RATE_PAIR_LIMIT,
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
  /** Set on a non-blocking decision when only a suspect (human-plausible) notice pattern matched. */
  suspect?: string;
}

export function parseHop(headers: Record<string, string>): number {
  // Parse each header independently and take the max so a low/invalid value in one
  // header cannot mask a higher hop count in the other.
  let max = 0;
  for (const name of ["x-agentpeer-hop", "x-bot-mail-hop"]) {
    const raw = headerValue(headers, name).trim();
    if (!/^\d+$/.test(raw)) continue;
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
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
  if (prec === "bulk" || prec === "auto_reply" || prec === "junk" || prec === "list") {
    return { block: true, status: "blocked_autonotice", reason: `precedence: ${prec}` };
  }

  if (headerValue(h, "x-autoreply")) {
    return { block: true, status: "blocked_autonotice", reason: "x-autoreply" };
  }
  if (headerValue(h, "x-autorespond")) {
    return { block: true, status: "blocked_autonotice", reason: "x-autorespond" };
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

  const notice = matchesHardAutoNotice(msg.subject, msg.text);
  if (notice) {
    return { block: true, status: "blocked_autonotice", reason: `auto-notice pattern: ${notice}` };
  }

  const hop = parseHop(h);
  if (hop > MAX_HOP) {
    return { block: true, status: "blocked_loop", reason: `hop ${hop} > ${MAX_HOP}` };
  }

  const suspect = matchesSuspectAutoNotice(msg.subject, msg.text);
  return suspect ? { block: false, suspect } : { block: false };
}

/**
 * Rate breaker: same (from, recipient) 5 / 10 min (then blocked for RATE_BLOCK_MS),
 * same (from, recipient, thread) 5 / 10 min, or same sender 30 / 10 min.
 * Counts already-stored messages in the window (the current row is included).
 * The caller records the event for any block returned.
 */
export async function inspectRate(
  store: Store,
  msg: NormalizedMessage,
): Promise<LoopDecision> {
  const since = msg.receivedAt - RATE_WINDOW_MS;
  const pair = { fromAddr: msg.from.addr, recipient: msg.recipient };
  const blockedUntil = await store.getPairBlock(pair);
  if (blockedUntil !== null && msg.receivedAt < blockedUntil) {
    return {
      block: true,
      status: "blocked_loop",
      reason: `pair block active until ${new Date(blockedUntil).toISOString()}`,
    };
  }
  const pairCount = await store.countPairWindow({ ...pair, since });
  if (pairCount > RATE_PAIR_LIMIT) {
    const until = msg.receivedAt + RATE_BLOCK_MS;
    await store.setPairBlock({ ...pair, blockedUntil: until });
    return {
      block: true,
      status: "blocked_loop",
      reason: `rate breaker: ${pairCount} from pair in window (limit ${RATE_PAIR_LIMIT}/10m); blocked until ${new Date(until).toISOString()}`,
    };
  }
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
  const rate = await inspectRate(store, msg);
  if (rate.block || !header.suspect) return rate;
  return { ...rate, suspect: header.suspect };
}
