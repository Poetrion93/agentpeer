import type { Store } from "./db.ts";

const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function consoleUnauthorized(): Response {
  return new Response("unauthorized", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8", "content-security-policy": CSP },
  });
}

export function checkConsoleToken(req: Request, token: string | undefined): boolean {
  if (!token) return false;
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ") && auth.slice(7).trim() === token) return true;
  if ((req.headers.get("x-console-token") ?? "") === token) return true;
  const url = new URL(req.url);
  // Query token is convenient for a first look; prefer the header in production.
  if (url.searchParams.get("token") === token) return true;
  return false;
}

export async function renderConsole(store: Store): Promise<Response> {
  const messages = await store.listMessages(100);
  const rows = [];
  for (const m of messages) {
    const ev = await store.listEvents(m.id);
    const del = await store.listDeliveries(m.id);
    const lastDel = del[del.length - 1];
    const eventSummary = ev.map((e) => `${e.type}: ${e.detail}`).join(" · ");
    rows.push(`<tr>
      <td>${escapeHtml(new Date(m.received_at).toISOString())}</td>
      <td>${escapeHtml(m.from_addr)}</td>
      <td>${escapeHtml(m.recipient)}</td>
      <td>${escapeHtml(m.subject)}</td>
      <td><code>${escapeHtml(m.status)}</code></td>
      <td>${escapeHtml(lastDel ? `${lastDel.adapter} #${lastDel.attempt} ${lastDel.http_status ?? ""} ${lastDel.error ?? ""}`.trim() : "—")}</td>
      <td>${escapeHtml(eventSummary)}</td>
    </tr>`);
  }
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>agentpeer console</title>
  <style>
    body { font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; margin: 24px; color: #111; background: #fff; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    p.sub { color: #555; margin: 0 0 20px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid #ddd; text-align: left; padding: 8px 10px; vertical-align: top; }
    th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #444; }
    code { font: 12px/1.4 ui-monospace, monospace; }
    .note { margin-top: 18px; color: #666; font-size: 12px; }
  </style>
</head>
<body>
  <h1>agentpeer /console</h1>
  <p class="sub">Read-only. Bodies are not rendered as HTML. Mail text is always untrusted input.</p>
  <table>
    <thead>
      <tr>
        <th>Received</th><th>From</th><th>Recipient</th><th>Subject</th>
        <th>Status</th><th>Delivery</th><th>Events</th>
      </tr>
    </thead>
    <tbody>
      ${rows.join("\n") || '<tr><td colspan="7">No messages.</td></tr>'}
    </tbody>
  </table>
  <p class="note">MVP in progress, not deployed. This page is text-only by design.</p>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": CSP,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
    },
  });
}

export async function messagesApi(store: Store): Promise<Response> {
  const messages = await store.listMessages(100);
  return json({ messages });
}

export async function messageApi(store: Store, id: string): Promise<Response> {
  const message = await store.getMessage(id);
  if (!message) return json({ error: "not found" }, 404);
  const events = await store.listEvents(id);
  const deliveries = await store.listDeliveries(id);
  return json({ message, events, deliveries });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-security-policy": "default-src 'none'",
      "cache-control": "no-store",
    },
  });
}
