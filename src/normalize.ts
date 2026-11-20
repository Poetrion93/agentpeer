import type { AuthFlags, MessageKind, NormalizedMessage } from "./types.ts";

type UnknownRecord = Record<string, unknown>;

function asRecord(v: unknown): UnknownRecord {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as UnknownRecord) : {};
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function lowerKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Canonical Message-ID: strip all <> and whitespace, lowercase, re-wrap as <id>.
 * Clean lowercase ids keep their previous <id> form, so stored dedup keys stay valid.
 * Returns null if missing/blank.
 */
export function normalizeMessageId(raw: unknown): string | null {
  const inner = asString(raw).replace(/[<>\s]/g, "").toLowerCase();
  if (!inner) return null;
  return `<${inner}>`;
}

export function headerValue(headers: Record<string, string>, name: string): string {
  return headers[name.toLowerCase()] ?? "";
}

/**
 * thread_id: first References value, else In-Reply-To, else the message's own id.
 */
export function threadIdFrom(headers: Record<string, string>, messageId: string | null): string {
  const references = headerValue(headers, "references");
  if (references) {
    const first = references.split(/\s+/).map((t) => normalizeMessageId(t)).find(Boolean);
    if (first) return first;
  }
  const irt = normalizeMessageId(headerValue(headers, "in-reply-to"));
  if (irt) return irt;
  return messageId ?? "";
}

function collectHeaders(payload: UnknownRecord): Record<string, string> {
  const out: Record<string, string> = {};
  const headers = payload.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const [k, v] of Object.entries(headers as UnknownRecord)) {
      if (typeof v === "string") out[k] = v;
      else if (Array.isArray(v) && v.length) out[k] = v.map(asString).join(", ");
      else if (v && typeof v === "object" && "value" in (v as UnknownRecord)) {
        out[k] = asString((v as UnknownRecord).value);
      }
    }
  }
  const lines = payload.headerLines;
  if (Array.isArray(lines)) {
    for (const line of lines) {
      const rec = asRecord(line);
      const key = asString(rec.key || rec.name);
      if (!key) continue;
      const value =
        asString(rec.value) ||
        asString(rec.line).replace(/^[^:]+:\s*/i, "");
      if (value) out[key] = value;
    }
  }
  return lowerKeys(out);
}

function addressFrom(node: unknown): { addr: string; name: string } {
  const rec = asRecord(node);
  if (Array.isArray(rec.value) && rec.value[0]) {
    const first = asRecord(rec.value[0]);
    return { addr: asString(first.address).toLowerCase(), name: asString(first.name) };
  }
  if (typeof rec.address === "string") {
    return { addr: rec.address.toLowerCase(), name: asString(rec.name) };
  }
  const text = asString(rec.text || node);
  const m = text.match(/<?([^\s<>]+@[^\s<>]+)>?/);
  return { addr: (m?.[1] ?? text).toLowerCase(), name: "" };
}

function addressList(node: unknown): string[] {
  const rec = asRecord(node);
  if (Array.isArray(rec.value)) {
    return rec.value
      .map((v) => asString(asRecord(v).address).toLowerCase())
      .filter(Boolean);
  }
  if (Array.isArray(node)) {
    return node
      .map((v) => (typeof v === "string" ? v : asString(asRecord(v).address)).toLowerCase())
      .filter(Boolean);
  }
  const text = asString(rec.text || node);
  return (text.match(/[^\s,<]+@[^\s,>]+/g) ?? []).map((s) => s.toLowerCase());
}

function authFrom(payload: UnknownRecord): AuthFlags {
  const dkim = asString(payload.dkim);
  const spf = asString(payload.spf);
  const dmarcNode = payload.dmarc;
  let dmarc = "";
  if (typeof dmarcNode === "string") dmarc = dmarcNode;
  else {
    const rec = asRecord(dmarcNode);
    const status = asRecord(rec.status);
    dmarc = asString(status.result || rec.result || rec.value);
  }
  return {
    ...(dkim ? { dkim } : {}),
    ...(spf ? { spf } : {}),
    ...(dmarc ? { dmarc } : {}),
  };
}

function detectKind(subject: string, headers: Record<string, string>): MessageKind {
  if (/^\[TEST\]/i.test(subject.trim())) return "test";
  const auto = headerValue(headers, "auto-submitted");
  if (auto && auto.toLowerCase() !== "no") return "auto_notice";
  const prec = headerValue(headers, "precedence").toLowerCase();
  if (prec === "bulk" || prec === "auto_reply" || prec === "junk" || prec === "list") {
    return "auto_notice";
  }
  if (headerValue(headers, "x-autoreply") || headerValue(headers, "x-autorespond") || headerValue(headers, "x-auto-response-suppress")) {
    return "auto_notice";
  }
  return "human";
}

export function recipientsFromPayload(payload: unknown): string[] {
  const rec = asRecord(payload);
  const session = asRecord(rec.session);
  const list: string[] = [];
  if (Array.isArray(rec.recipients)) {
    for (const r of rec.recipients) list.push(asString(r).toLowerCase());
  }
  const sessionRecipient = asString(session.recipient).toLowerCase();
  if (sessionRecipient && !list.includes(sessionRecipient)) list.unshift(sessionRecipient);
  if (!list.length) {
    const envelope = asRecord(rec.envelope);
    if (Array.isArray(envelope.to)) {
      for (const r of envelope.to) list.push(asString(r).toLowerCase());
    }
  }
  if (!list.length) list.push(...addressList(rec.to));
  return [...new Set(list.filter(Boolean))];
}

export function normalize(
  payload: unknown,
  recipient: string,
  now: number,
  tenantId = "ounce",
): NormalizedMessage {
  const rec = asRecord(payload);
  const headers = collectHeaders(rec);
  const messageId =
    normalizeMessageId(rec.messageId) ??
    normalizeMessageId(headerValue(headers, "message-id"));
  const subject = asString(rec.subject || headerValue(headers, "subject"));
  const from = addressFrom(rec.from) ;
  if (!from.addr) {
    const session = asRecord(rec.session);
    from.addr = asString(session.sender || rec.sender).toLowerCase();
  }
  const text = asString(rec.text) || asString(rec.html).replace(/<[^>]+>/g, " ");
  const dateHeader = asString(rec.date || headerValue(headers, "date"));
  const to = addressList(rec.to);
  const threadId = threadIdFrom(headers, messageId);

  return {
    tenantId,
    channel: "email",
    source: "forwardemail",
    messageId,
    threadId: threadId || messageId || `thread:${recipient}:${now}`,
    from,
    to: to.length ? to : [recipient],
    recipient: recipient.toLowerCase(),
    kind: detectKind(subject, headers),
    auth: authFrom(rec),
    subject,
    text: text.trim(),
    rawRef: rec.raw ? "inline" : null,
    attachmentsMeta: Array.isArray(rec.attachments)
      ? rec.attachments.map((a) => {
          const x = asRecord(a);
          return { filename: asString(x.filename), contentType: asString(x.contentType), size: x.size ?? null };
        })
      : [],
    headers,
    receivedAt: now,
    dateHeader,
  };
}

export function headersSubset(headers: Record<string, string>): Record<string, string> {
  const keep = [
    "message-id",
    "in-reply-to",
    "references",
    "auto-submitted",
    "x-loop",
    "x-agentpeer-hop",
    "x-bot-mail-hop",
    "precedence",
    "x-autoreply",
    "x-autorespond",
    "x-auto-response-suppress",
    "list-id",
    "return-path",
    "from",
    "to",
    "subject",
    "date",
  ];
  const out: Record<string, string> = {};
  for (const k of keep) if (headers[k]) out[k] = headers[k];
  return out;
}
