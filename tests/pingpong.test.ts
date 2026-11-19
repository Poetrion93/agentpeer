import { describe, expect, it } from "vitest";
import { processOne } from "../src/pipeline.ts";
import { BOT_A, BOT_B, deps, fePayload } from "./helpers.ts";

/**
 * Reproduces a real 2026-11-19 incident: two bots exchanged
 * "No home channel" auto-replies 12 times. The loop guard must
 * stop delivery so that ping-pong cannot complete a 12-round loop.
 */
describe("No home channel ping-pong (12-round incident)", () => {
  const thread = "<home-channel-incident@bots.example.com>";

  it("blocks all 12 auto-replies and delivers none", async () => {
    const d = deps();
    const results = [];
    for (let n = 1; n <= 12; n++) {
      const from = n % 2 === 1 ? BOT_A : BOT_B;
      const to = n % 2 === 1 ? BOT_B : BOT_A;
      const inReplyTo = n === 1 ? thread : `<pong-${n - 1}@bots.example.com>`;
      results.push(
        await processOne(
          fePayload({
            messageId: `<pong-${n}@bots.example.com>`,
            from,
            to,
            subject: "No home channel",
            text: "This agent does not have a home channel configured. No home channel.",
            headers: {
              "auto-submitted": "auto-replied",
              "precedence": "auto_reply",
              "in-reply-to": inReplyTo,
              references: `${thread} ${inReplyTo}`,
            },
          }),
          to,
          d,
        ),
      );
    }

    expect(results).toHaveLength(12);
    expect(results.every((r) => r.status === "blocked_autonotice")).toBe(true);
    expect(results.filter((r) => r.status === "delivered")).toHaveLength(0);
    const rows = await d.store.listMessages(20);
    expect(rows).toHaveLength(12);
    expect(rows.every((m) => m.status === "blocked_autonotice")).toBe(true);
  });

  it("still blocks the loop when Auto-Submitted is missing but the notice text is present", async () => {
    const d = deps();
    const results = [];
    for (let n = 1; n <= 12; n++) {
      const from = n % 2 === 1 ? BOT_A : BOT_B;
      const to = n % 2 === 1 ? BOT_B : BOT_A;
      results.push(
        await processOne(
          fePayload({
            messageId: `<plain-${n}@bots.example.com>`,
            from,
            to,
            subject: "Re: task",
            text: "Error: No home channel is set for this profile.",
            headers: {
              "in-reply-to": thread,
              references: thread,
            },
          }),
          to,
          d,
        ),
      );
    }
    expect(results.every((r) => r.status === "blocked_autonotice")).toBe(true);
    expect(results[0].reason).toMatch(/auto-notice pattern/i);
  });
});
