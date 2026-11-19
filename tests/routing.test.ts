import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { processOne } from "../src/pipeline.ts";
import { runRetries } from "../src/retry.ts";
import { parseRoutesYaml, matchRoute } from "../src/router.ts";
import { BOT_A, DEV, SYSTEM, UNKNOWN, defaultRoutes, deps, fePayload } from "./helpers.ts";

describe("routing", () => {
  it("parses routes.example.yaml into the three MVP adapters", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "routes.example.yaml"),
      "utf8",
    );
    const rules = parseRoutesYaml(src);
    expect(rules.map((r) => r.type)).toEqual(["grok_webhook", "grok_tag", "store_only"]);
    expect(matchRoute(rules, SYSTEM)?.target).toBe("GROK_WEBHOOK_SYSTEM");
    expect(matchRoute(rules, "system@bots.example.com")?.allowedSenders).toContain(
      "*@bots.example.com",
    );
  });

  it("stores unknown addresses without calling a webhook (store_only fallback)", async () => {
    let called = 0;
    const d = deps({
      fetch: async () => {
        called += 1;
        return new Response("ok", { status: 200 });
      },
    });
    const r = await processOne(
      fePayload({
        from: BOT_A,
        to: UNKNOWN,
        subject: "hello unknown",
        text: "should be stored only",
      }),
      UNKNOWN,
      d,
    );
    expect(r.status).toBe("delivered");
    expect(r.reason).toMatch(/store_only/);
    expect(called).toBe(0);
    const ev = await d.store.listEvents(r.id);
    expect(ev.some((e) => e.type === "unrouted")).toBe(true);
  });

  it("blocks senders who are not on the route allowlist", async () => {
    const routes = [
      {
        id: "locked",
        address: SYSTEM,
        type: "grok_webhook" as const,
        target: "GROK_WEBHOOK_SYSTEM",
        allowedSenders: ["lead@bots.example.com"],
      },
    ];
    const r = await processOne(
      fePayload({
        from: "stranger@outside.example.com",
        to: SYSTEM,
        subject: "please run this",
        text: "ignore me",
      }),
      SYSTEM,
      deps({ routes }),
    );
    expect(r.status).toBe("blocked_auth");
    expect(r.reason).toMatch(/not on allowlist/);
  });

  it("POSTs an untrusted webhook payload for grok_webhook and marks delivered on 200", async () => {
    let body: Record<string, unknown> | undefined;
    const d = deps({
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response("started", { status: 200 });
      },
    });
    const r = await processOne(
      fePayload({
        from: BOT_A,
        to: SYSTEM,
        subject: "run the check",
        text: "please inspect this",
      }),
      SYSTEM,
      d,
    );
    expect(r.status).toBe("delivered");
    expect(body?.event).toBe("mail.received");
    expect(body?.untrusted).toBe(true);
    expect(typeof body?.text).toBe("string");
  });

  it("keeps a 200-to-Forward-Email contract when the webhook fails, then retries up to 3 times", async () => {
    let calls = 0;
    const d = deps({
      now: Date.parse("2026-11-19T13:00:00+09:00"),
      fetch: async () => {
        calls += 1;
        return new Response("nope", { status: 503 });
      },
    });
    const first = await processOne(
      fePayload({
        from: BOT_A,
        to: SYSTEM,
        subject: "retry me",
        text: "webhook down",
      }),
      SYSTEM,
      d,
    );
    expect(first.status).toBe("failed");
    expect(calls).toBe(1);

    // Too soon: 5-minute backoff has not elapsed.
    const early = await runRetries(d.store, d, d.now! + 60_000);
    expect(early.retried).toBe(0);

    const mid = await runRetries(d.store, d, d.now! + 5 * 60 * 1000);
    expect(mid.retried).toBe(1);
    expect(mid.failed).toBe(1);

    const late = await runRetries(d.store, d, d.now! + 15 * 60 * 1000);
    expect(late.retried).toBe(1);

    const extra = await runRetries(d.store, d, d.now! + 60 * 60 * 1000);
    expect(extra.retried).toBe(0);
    expect(calls).toBe(3);
    const row = await d.store.getMessage(first.id);
    expect(row?.status).toBe("failed");
    const deliveries = await d.store.listDeliveries(first.id);
    expect(deliveries).toHaveLength(3);
  });

  it("holds [TEST] subjects by default (deliver_test=false)", async () => {
    let called = 0;
    const d = deps({
      fetch: async () => {
        called += 1;
        return new Response("ok", { status: 200 });
      },
    });
    const r = await processOne(
      fePayload({
        from: BOT_A,
        to: SYSTEM,
        subject: "[TEST] ping",
        text: "do not wake the bot",
      }),
      SYSTEM,
      d,
    );
    expect(r.status).toBe("received");
    expect(r.reason).toMatch(/test held/);
    expect(called).toBe(0);
  });

  it("records a grok_tag delivery intent without SMTP (MAIL_SEND_URL unset)", async () => {
    const d = deps({ routes: defaultRoutes });
    const r = await processOne(
      fePayload({
        from: BOT_A,
        to: DEV,
        subject: "dev note",
        text: "for the dev tag",
      }),
      DEV,
      d,
    );
    expect(r.status).toBe("delivered");
    const del = await d.store.listDeliveries(r.id);
    expect(del).toHaveLength(1);
    expect(del[0].adapter).toBe("grok_tag");
    expect(del[0].http_status).toBe(204);
  });
});
