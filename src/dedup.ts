import { sha256Hex } from "./crypto.ts";
import type { NormalizedMessage } from "./types.ts";

/**
 * Dedup key = normalized Message-ID + recipient.
 * Fallback when Message-ID is missing: sha256(from|subject|date|body) + recipient.
 */
export async function dedupKey(msg: NormalizedMessage): Promise<string> {
  const recipient = msg.recipient.toLowerCase();
  if (msg.messageId) return `${msg.messageId}|${recipient}`;
  const basis = [msg.from.addr, msg.subject, msg.dateHeader, msg.text].join("|");
  const hash = await sha256Hex(basis);
  return `sha256:${hash}|${recipient}`;
}
