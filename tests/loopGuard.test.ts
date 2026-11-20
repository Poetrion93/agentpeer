import { describe, expect, it } from "vitest";
import { processOne } from "../src/pipeline.ts";
import { memoryStore } from "../src/sqlite.ts";
import { inspectRate } from "../src/loopGuard.ts";
import type { NormalizedMessage } from "../src/types.ts";
import type { Store } from "../src/db.ts";
import {
  RATE_BLOCK_MS,
  RATE_PAIR_LIMIT,
  RATE_SENDER_LIMIT,
  RATE_THREAD_LIMIT,
} from "../src/types.ts";
import { ARCHIVE, BOT_A, DEV, SYSTEM, UNKNOWN, deps, fePayload } from "./helpers.ts";

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

  // While RATE_PAIR_LIMIT === RATE_THREAD_LIMIT the pair rule fires first and the thread rule is
  // subsumed here; the thread branch is proven separately via inspectRate unit tests below.
  it("blocks the 6th in-thread message within 10 minutes (pair rule fires first)", async () => {
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
    expect(last.reason).toMatch(/from pair in window/);
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

  it.each([
    ["out of office", "Out of Office: back Monday", "I am away."],
    ["부재중", "자동 응답", "현재 부재중입니다."],
    ["no home channel", "Re: task", "Error: No home channel is set."],
  ])("blocks the %s notice pattern even without auto headers", async (_n, subject, text) => {
    const r = await processOne(
      fePayload({ from: BOT_A, to: SYSTEM, subject, text }),
      SYSTEM,
      deps(),
    );
    expect(r.status).toBe("blocked_autonotice");
    expect(r.reason).toMatch(/auto-notice pattern/);
  });

  it("delivers a normal human body with Auto-Submitted: no", async () => {
    const r = await processOne(
      fePayload({
        from: BOT_A,
        to: SYSTEM,
        subject: "status",
        text: "Can you review the draft?",
        headers: { "auto-submitted": "no" },
      }),
      SYSTEM,
      deps(),
    );
    expect(r.status).toBe("delivered");
  });

  it("blocks Precedence: list and X-Autorespond; allows Precedence: first-class", async () => {
    const list = await processOne(
      fePayload({ from: BOT_A, to: SYSTEM, subject: "digest", text: "hi", headers: { precedence: "list" } }),
      SYSTEM,
      deps(),
    );
    expect(list.status).toBe("blocked_autonotice");
    const auto = await processOne(
      fePayload({ from: BOT_A, to: SYSTEM, subject: "hi", text: "hi", headers: { "x-autorespond": "yes" } }),
      SYSTEM,
      deps(),
    );
    expect(auto.status).toBe("blocked_autonotice");
    expect(auto.reason).toMatch(/x-autorespond/);
    const ok = await processOne(
      fePayload({ from: BOT_A, to: SYSTEM, subject: "hi", text: "hi", headers: { precedence: "first-class" } }),
      SYSTEM,
      deps(),
    );
    expect(ok.status).toBe("delivered");
  });

  it("records an event for blocked auto-notices and hop 4, and nothing is delivered", async () => {
    const d = deps();
    const notice = await processOne(
      fePayload({ from: BOT_A, to: SYSTEM, subject: "ooo", text: "부재중", messageId: "<n1@bots.example.com>" }),
      SYSTEM,
      d,
    );
    const hop = await processOne(
      fePayload({
        from: BOT_A,
        to: SYSTEM,
        subject: "far",
        text: "x",
        messageId: "<h4@bots.example.com>",
        headers: { "x-bot-mail-hop": "4" },
      }),
      SYSTEM,
      d,
    );
    expect((await d.store.listEvents(notice.id)).map((e) => e.type)).toContain("blocked_autonotice");
    expect((await d.store.listEvents(hop.id)).map((e) => e.type)).toContain("blocked_loop");
    expect(await d.store.listDeliveries(hop.id)).toHaveLength(0);
  });

  it("uses the max of both hop headers (agentpeer=0, bot-mail=4 is blocked)", async () => {
    const r = await processOne(
      fePayload({
        from: BOT_A,
        to: SYSTEM,
        subject: "bypass",
        text: "x",
        headers: { "x-agentpeer-hop": "0", "x-bot-mail-hop": "4" },
      }),
      SYSTEM,
      deps(),
    );
    expect(r.status).toBe("blocked_loop");
  });

  it("stamps outbound hop = max(inbound hops) + 1 on both headers", async () => {
    let sent: { headers: Record<string, string> } | undefined;
    const d = deps({
      env: { MAIL_SEND_URL: "https://example.invalid/send" },
      fetch: async (_u, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response("ok", { status: 200 });
      },
    });
    const r = await processOne(
      fePayload({
        from: BOT_A,
        to: DEV,
        subject: "go",
        text: "hello",
        headers: { "x-agentpeer-hop": "1", "x-bot-mail-hop": "3" },
      }),
      DEV,
      d,
    );
    expect(r.status).toBe("delivered");
    expect(sent?.headers["X-Bot-Mail-Hop"]).toBe("4");
    expect(sent?.headers["X-Agentpeer-Hop"]).toBe("4");
  });

  it("stamps X-Bot-Mail-Hop and X-Agentpeer-Hop = inbound + 1 on grok_tag sends", async () => {
    let sent: { headers: Record<string, string> } | undefined;
    const d = deps({
      env: { MAIL_SEND_URL: "https://example.invalid/send" },
      fetch: async (_u, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response("ok", { status: 200 });
      },
    });
    const r = await processOne(
      fePayload({ from: BOT_A, to: DEV, subject: "go", text: "hello", headers: { "x-bot-mail-hop": "2" } }),
      DEV,
      d,
    );
    expect(r.status).toBe("delivered");
    expect(sent?.headers["X-Bot-Mail-Hop"]).toBe("3");
    expect(sent?.headers["X-Agentpeer-Hop"]).toBe("3");
    expect(sent?.headers["Auto-Submitted"]).toBe("auto-generated");
  });

  describe("(from, recipient) pair rate window", () => {
    const send = (d: ReturnType<typeof deps>, i: number, to = SYSTEM) =>
      processOne(
        fePayload({
          messageId: `<pair-${to}-${i}@bots.example.com>`,
          from: BOT_A,
          to,
          subject: `m${i}`,
          text: `b${i}`,
          headers: { references: `<t-${i}@bots.example.com>` },
        }),
        to,
        d,
      );

    it("delivers 5, blocks the 6th, still delivers another recipient", async () => {
      const d = deps();
      for (let i = 1; i <= RATE_PAIR_LIMIT; i++) expect((await send(d, i)).status).toBe("delivered");
      const sixth = await send(d, 6);
      expect(sixth.status).toBe("blocked_loop");
      expect(sixth.reason).toMatch(/rate breaker/);
      expect((await d.store.listEvents(sixth.id)).map((e) => e.type)).toContain("blocked_loop");
      expect((await send(d, 7, ARCHIVE)).status).toBe("delivered");
    });

    it("stays blocked during RATE_BLOCK_MS and delivers again after it", async () => {
      const t0 = Date.parse("2026-11-19T13:00:00+09:00");
      const store = memoryStore();
      for (let i = 1; i <= RATE_PAIR_LIMIT; i++) await send(deps({ store, now: t0 }), i);
      expect((await send(deps({ store, now: t0 }), 6)).status).toBe("blocked_loop");
      const during = await send(deps({ store, now: t0 + 60_000 }), 7);
      expect(during.status).toBe("blocked_loop");
      expect(during.reason).toMatch(/pair block active/);
      const after = await send(deps({ store, now: t0 + RATE_BLOCK_MS + 1 }), 8);
      expect(after.status).toBe("delivered");
    });
  });
});

describe("inspectRate window branches", () => {
  const msg = {
    from: { addr: BOT_A },
    recipient: SYSTEM,
    threadId: "<t@bots.example.com>",
    receivedAt: 1_000_000_000,
  } as unknown as NormalizedMessage;
  const stub = (counts: { thread: number; sender: number }) =>
    ({
      getPairBlock: async () => null,
      countPairWindow: async () => 0,
      countThreadWindow: async () => counts.thread,
      countSenderWindow: async () => counts.sender,
    }) as unknown as Store;

  it("blocks on the thread window", async () => {
    const r = await inspectRate(stub({ thread: RATE_THREAD_LIMIT + 1, sender: 0 }), msg);
    expect(r.block).toBe(true);
    expect(r.block && r.reason).toMatch(/thread window/);
  });

  it("blocks on the sender window", async () => {
    const r = await inspectRate(stub({ thread: 0, sender: RATE_SENDER_LIMIT + 1 }), msg);
    expect(r.block).toBe(true);
    expect(r.block && r.reason).toMatch(/from sender/);
  });

  it("end-to-end: 31st message from one sender across recipients is sender-blocked", async () => {
    const d = deps();
    const rcpts = [SYSTEM, DEV, ARCHIVE, UNKNOWN, "u1@bots.example.com", "u2@bots.example.com", "u3@bots.example.com"];
    const results = [];
    for (let i = 0; i < RATE_SENDER_LIMIT + 1; i++) {
      const to = rcpts[Math.floor(i / RATE_PAIR_LIMIT)];
      results.push(
        await processOne(
          fePayload({
            messageId: `<snd-${i}@bots.example.com>`,
            from: BOT_A,
            to,
            subject: `s${i}`,
            text: `b${i}`,
            headers: { references: `<snd-t-${i}@bots.example.com>` },
          }),
          to,
          d,
        ),
      );
    }
    expect(results.slice(0, RATE_SENDER_LIMIT).some((r) => r.status === "blocked_loop")).toBe(false);
    const last = results[RATE_SENDER_LIMIT];
    expect(last.status).toBe("blocked_loop");
    expect(last.reason).toMatch(/from sender/);
  });
});
