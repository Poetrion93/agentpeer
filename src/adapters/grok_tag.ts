import { webhookPayload } from "../trust.ts";
import type { DeliveryAdapter } from "./types.ts";

/**
 * grok_tag delivers to an address like inbox+tag@….
 * shortcut: no SMTP in this MVP; POST to MAIL_SEND_URL if configured.
 * upgrade: add SES/Resend/SMTP with Auto-Submitted and X-Agentpeer-Hop.
 * The router itself never auto-replies.
 */
export const grokTagAdapter: DeliveryAdapter = {
  type: "grok_tag",
  async deliver(rowId, msg, route, ctx) {
    const target = route.target;
    if (!target) return { ok: false, error: "grok_tag target address missing" };
    const sendUrl = ctx.env.MAIL_SEND_URL;
    if (!sendUrl) {
      // No transport yet — treat as stored intent so local tests and dry-runs work.
      return { ok: true, httpStatus: 204, error: "deferred: MAIL_SEND_URL not set" };
    }
    const body = {
      ...webhookPayload(
        {
          id: rowId,
          threadId: msg.threadId,
          from: msg.from,
          to: [target],
          recipient: target,
          subject: msg.subject,
          text: msg.text,
          auth: msg.auth,
        },
        ctx.consoleUrl,
      ),
      headers: {
        "Auto-Submitted": "auto-generated",
        "X-Bot-Mail-Hop": String(ctx.nextHop),
        "X-Agentpeer-Hop": String(ctx.nextHop),
        "X-Loop": ctx.loopToken,
      },
    };
    try {
      const res = await ctx.fetch(sendUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, httpStatus: res.status };
      return { ok: false, httpStatus: res.status, error: `mail send status ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
