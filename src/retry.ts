import type { Store } from "./db.ts";
import { parseHop } from "./loopGuard.ts";
import { deliver, type PipelineDeps } from "./pipeline.ts";
import { matchRoute } from "./router.ts";
import { MAX_DELIVERY_ATTEMPTS, type NormalizedMessage } from "./types.ts";

function backoffMs(attempt: number): number {
  // 5 min cron * 2^(attempt-1) — first retry after 5m, then 10m, then 20m.
  return 5 * 60 * 1000 * 2 ** Math.max(0, attempt - 1);
}

function rowToMsg(row: {
  tenant_id: string;
  message_id: string | null;
  thread_id: string;
  from_addr: string;
  from_name: string;
  recipients_json: string;
  recipient: string;
  kind: string;
  auth_json: string;
  subject: string;
  text: string;
  headers_subset_json: string;
  received_at: number;
}): NormalizedMessage {
  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(row.headers_subset_json) as Record<string, string>;
  } catch {
    headers = {};
  }
  let to: string[] = [];
  try {
    to = JSON.parse(row.recipients_json) as string[];
  } catch {
    to = [row.recipient];
  }
  let auth = {};
  try {
    auth = JSON.parse(row.auth_json) as object;
  } catch {
    auth = {};
  }
  return {
    tenantId: row.tenant_id,
    channel: "email",
    source: "forwardemail",
    messageId: row.message_id,
    threadId: row.thread_id,
    from: { addr: row.from_addr, name: row.from_name },
    to,
    recipient: row.recipient,
    kind: row.kind as NormalizedMessage["kind"],
    auth,
    subject: row.subject,
    text: row.text,
    rawRef: null,
    attachmentsMeta: [],
    headers,
    receivedAt: row.received_at,
    dateHeader: headers.date ?? "",
  };
}

/**
 * Retry cron (every 5 minutes, max 3 attempts, exponential backoff).
 * Delivery failure never causes a non-200 to Forward Email — this runs later.
 */
export async function runRetries(
  store: Store,
  deps: Omit<PipelineDeps, "store">,
  now = Date.now(),
  maxAttempts = MAX_DELIVERY_ATTEMPTS,
): Promise<{ retried: number; delivered: number; failed: number }> {
  const dueCutoff = now; // listRetryable filters by last delivery time vs now; refine below
  const candidates = await store.listRetryable(dueCutoff, maxAttempts);
  let retried = 0;
  let delivered = 0;
  let failed = 0;
  for (const row of candidates) {
    const deliveries = await store.listDeliveries(row.id);
    const attempt = deliveries.length + 1;
    if (attempt > maxAttempts) continue;
    const last = deliveries[deliveries.length - 1];
    if (last && now - last.at < backoffMs(deliveries.length)) continue;
    const route = matchRoute(deps.routes, row.recipient);
    if (!route || route.type === "store_only" || route.type === "drop") continue;
    const msg = rowToMsg(row);
    // hop is whatever arrived; we do not increment on webhook retry
    void parseHop(msg.headers);
    const result = await deliver(row.id, msg, route, { ...deps, store }, now, attempt);
    retried += 1;
    if (result.status === "delivered") delivered += 1;
    else failed += 1;
  }
  return { retried, delivered, failed };
}
