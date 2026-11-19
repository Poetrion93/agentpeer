import type { RouteRule } from "./types.ts";

export interface TrustDecision {
  allowed: boolean;
  reason?: string;
}

function wildcardMatch(pattern: string, addr: string): boolean {
  const p = pattern.toLowerCase();
  const a = addr.toLowerCase();
  if (p === a) return true;
  if (p.startsWith("*@")) return a.endsWith(p.slice(1)) || a.split("@")[1] === p.slice(2);
  if (p === "*") return true;
  return false;
}

/**
 * Sender allowlist on the matched route. Body is always untrusted,
 * even when the sender is allowed.
 */
export function checkTrust(fromAddr: string, route: RouteRule | null): TrustDecision {
  if (!route || route.allowedSenders.length === 0) return { allowed: true };
  const ok = route.allowedSenders.some((p) => wildcardMatch(p, fromAddr));
  if (!ok) {
    return { allowed: false, reason: `sender ${fromAddr} not on allowlist for ${route.address}` };
  }
  return { allowed: true };
}

export function webhookPayload(
  msg: {
    id: string;
    threadId: string;
    from: { addr: string; name: string };
    to: string[];
    recipient: string;
    subject: string;
    text: string;
    auth: unknown;
  },
  consoleUrl?: string,
) {
  return {
    event: "mail.received",
    id: msg.id,
    thread_id: msg.threadId,
    from: msg.from,
    to: msg.to,
    recipient: msg.recipient,
    subject: msg.subject,
    text: msg.text.slice(0, 4000),
    auth: msg.auth,
    untrusted: true as const,
    ...(consoleUrl ? { console_url: consoleUrl } : {}),
  };
}
