import { describe, expect, it } from "vitest";
import { processOne } from "../src/pipeline.ts";
import { RATE_THREAD_LIMIT } from "../src/types.ts";
import { BOT_A, SYSTEM, deps, fePayload } from "./helpers.ts";

describe("loop guard", () => {
  it("blocks Auto-Submitted when the value is not 'no'", async () => {
    const d = deps();
    const r = await processOne(
      fePayload({
        from: BOT_A,
        to: SYSTEM,
        subject: "ooo",
        text: "I am away",
        headers: { "auto-submitted": "auto-replied" },
      }),
      SYSTEM,
      d,
    );
    expect(r.status).toBe("blocked_autonotice");
    expect(r.reason).toMatch(/auto-submitted/i);
  });

  it("allows Auto-Submitted: no", async () => {
    const d = deps();
    const r = await processOne(
      fePayload({
        from: BOT_A,
        to: SYSTEM,
        subject: "real mail",
        text: "hello",
        headers: { "auto-submitted": "no" },
      }),
      SYSTEM,
      d,
    );
    expect(r.status).toBe("delivered");
  });

  it("blocks mail stamped with our X-Loop token", async () => {
    const d = deps();
    const r = await processOne(
      fePayload({
        from: BOT_A,
        to: SYSTEM,
        subject: "looped",
        text: "hello",
        headers: { "x-loop": "agentpeer" },
      }),
      SYSTEM,
      d,
    );
    expect(r.status).toBe("blocked_loop");
    expect(r.reason).toMatch(/x-loop/i);
  });

  it("allows hop 3 and blocks hop 4 (hop <= 3)", async () => {
    const allow = await processOne(
      fePayload({
        messageId: "<hop3@bots.example.com>",
        from: BOT_A,
        to: SYSTEM,
        subject: "third hop",
        text: "still ok",
        headers: { "x-agentpeer-hop": "3" },
      }),
      SYSTEM,
      deps(),
    );
    expect(allow.status).toBe("delivered");

    const block = await processOne(
      fePayload({
        messageId: "<hop4@bots.example.com>",
        from: BOT_A,
        to: SYSTEM,
        subject: "fourth hop",
        text: "too far",
        headers: { "x-agentpeer-hop": "4" },
      }),
      SYSTEM,
      deps(),
    );
    expect(block.status).toBe("blocked_loop");
    expect(block.reason).toMatch(/hop 4/);
  });

  it("also honors the legacy X-Bot-Mail-Hop header", async () => {
    const r = await processOne(
      fePayload({
        from: BOT_A,
        to: SYSTEM,
        subject: "legacy hop",
        text: "too far",
        headers: { "x-bot-mail-hop": "9" },
      }),
      SYSTEM,
      deps(),
    );
    expect(r.status).toBe("blocked_loop");
  });

  it("rate-breaks the 6th message in the same (from, recipient, thread) within 10 minutes", async () => {
    const d = deps();
    const thread = "<thread-rate@bots.example.com>";
    const results = [];
    for (let i = 1; i <= RATE_THREAD_LIMIT + 1; i++) {
      results.push(
        await processOne(
          fePayload({
            messageId: `<rate-${i}@bots.example.com>`,
            from: BOT_A,
            to: SYSTEM,
            subject: `msg ${i}`,
            text: `body ${i}`,
            headers: { references: thread },
          }),
          SYSTEM,
          d,
        ),
      );
    }
    expect(results.slice(0, RATE_THREAD_LIMIT).every((r) => r.status === "delivered")).toBe(true);
    const last = results[RATE_THREAD_LIMIT];
    expect(last.status).toBe("blocked_loop");
    expect(last.reason).toMatch(/rate breaker/i);
  });

  it("blocks mailer-daemon and empty Return-Path", async () => {
    const daemon = await processOne(
      fePayload({
        from: "mailer-daemon@bots.example.com",
        to: SYSTEM,
        subject: "Delivery Status Notification",
        text: "undeliverable",
      }),
      SYSTEM,
      deps(),
    );
    expect(daemon.status).toBe("blocked_autonotice");

    const empty = await processOne(
      fePayload({
        from: BOT_A,
        to: SYSTEM,
        subject: "bounce-like",
        text: "empty path",
        headers: { "return-path": "<>" },
      }),
      SYSTEM,
      deps(),
    );
    expect(empty.status).toBe("blocked_autonotice");
  });
});
