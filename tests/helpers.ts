import type { PipelineDeps } from "../src/pipeline.ts";
import { memoryStore } from "../src/sqlite.ts";
import type { RouteRule } from "../src/types.ts";

export const BOT_A = "bot-a@bots.example.com";
export const BOT_B = "bot-b@bots.example.com";
export const SYSTEM = "system@bots.example.com";
export const DEV = "dev@bots.example.com";
export const ARCHIVE = "archive@bots.example.com";
export const UNKNOWN = "unknown@bots.example.com";

export const defaultRoutes: RouteRule[] = [
  {
    id: "system",
    address: SYSTEM,
    type: "grok_webhook",
    target: "GROK_WEBHOOK_SYSTEM",
    allowedSenders: ["lead@bots.example.com", "*@bots.example.com"],
  },
  {
    id: "dev",
    address: DEV,
    type: "grok_tag",
    target: "inbox+dev@bots.example.com",
    allowedSenders: [],
  },
  {
    id: "archive",
    address: ARCHIVE,
    type: "store_only",
    allowedSenders: [],
  },
];

export function fePayload(opts: {
  messageId?: string | null;
  from: string;
  fromName?: string;
  to: string | string[];
  recipient?: string;
  subject: string;
  text: string;
  date?: string;
  headers?: Record<string, string>;
  recipients?: string[];
  dkim?: string;
  spf?: string;
  dmarc?: string;
}): Record<string, unknown> {
  const toList = Array.isArray(opts.to) ? opts.to : [opts.to];
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.messageId !== null) {
    const mid = opts.messageId ?? `<${crypto.randomUUID()}@bots.example.com>`;
    headers["message-id"] = mid;
  }
  headers.subject = opts.subject;
  headers.date = opts.date ?? "Thu, 19 Nov 2026 12:00:00 +0900";
  headers.from = opts.from;
  headers.to = toList.join(", ");

  const headerLines = Object.entries(headers).map(([key, value]) => ({
    key,
    line: `${key}: ${value}`,
  }));

  return {
    messageId: opts.messageId === null ? undefined : headers["message-id"],
    recipients: opts.recipients ?? toList,
    session: { recipient: opts.recipient ?? toList[0], sender: opts.from },
    from: { value: [{ address: opts.from, name: opts.fromName ?? "" }], text: opts.from },
    to: { value: toList.map((address) => ({ address, name: "" })), text: toList.join(", ") },
    subject: opts.subject,
    date: headers.date,
    text: opts.text,
    headers,
    headerLines,
    dkim: opts.dkim ?? "pass",
    spf: opts.spf ?? "pass",
    dmarc: { status: { result: opts.dmarc ?? "pass" } },
  };
}

export function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    store: over.store ?? memoryStore(),
    routes: over.routes ?? defaultRoutes,
    env: over.env ?? { GROK_WEBHOOK_SYSTEM: "https://example.invalid/hooks/system" },
    now: over.now ?? Date.parse("2026-11-19T13:00:00+09:00"),
    fetch:
      over.fetch ??
      (async () => new Response("ok", { status: 200 })),
    loopToken: over.loopToken ?? "agentpeer",
    tenantId: over.tenantId ?? "ounce",
    deliverTest: over.deliverTest,
    consoleUrl: over.consoleUrl,
  };
}
