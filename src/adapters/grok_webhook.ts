import { webhookPayload } from "../trust.ts";
import type { DeliveryAdapter } from "./types.ts";

export const grokWebhookAdapter: DeliveryAdapter = {
  type: "grok_webhook",
  async deliver(rowId, msg, route, ctx) {
    const secretName = route.target;
    if (!secretName) return { ok: false, error: "route target (env name) missing" };
    const url = ctx.env[secretName];
    if (!url) return { ok: false, error: `env ${secretName} is not set` };
    const body = webhookPayload(
      {
        id: rowId,
        threadId: msg.threadId,
        from: msg.from,
        to: msg.to,
        recipient: msg.recipient,
        subject: msg.subject,
        text: msg.text,
        auth: msg.auth,
      },
      ctx.consoleUrl,
    );
    try {
      const res = await ctx.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agentpeer-untrusted": "true" },
        body: JSON.stringify(body),
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, httpStatus: res.status };
      return { ok: false, httpStatus: res.status, error: `webhook status ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
