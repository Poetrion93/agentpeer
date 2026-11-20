import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeMessageId } from "../src/normalize.ts";
import { ingestForwardEmail, processOne } from "../src/pipeline.ts";
import { BOT_A, BOT_B, SYSTEM, deps, fePayload } from "./helpers.ts";

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/fe-webhook.json"), "utf8"),
) as unknown;

describe("dedup", () => {
  it("treats a second copy of the same Message-ID + recipient as a duplicate and still stores the first", async () => {
    const d = deps();
    const payload = fePayload({
      messageId: "<once@bots.example.com>",
      from: BOT_A,
      to: SYSTEM,
      subject: "hello",
      text: "first copy",
    });
    const a = await processOne(payload, SYSTEM, d);
    const b = await processOne(payload, SYSTEM, d);
    expect(a.status).toBe("delivered");
    expect(b.status).toBe("duplicate");
    expect(b.id).toBe(a.id);
    const rows = await d.store.listMessages();
    expect(rows).toHaveLength(1);
  });

  it("does not treat the same Message-ID for a different recipient as a duplicate", async () => {
    const d = deps();
    const payload = fePayload({
      messageId: "<shared@bots.example.com>",
      from: BOT_A,
      to: [SYSTEM, BOT_B],
      subject: "fanout",
      text: "two recipients",
    });
    const a = await processOne(payload, SYSTEM, d);
    const b = await processOne(payload, BOT_B, d);
    expect(a.status).not.toBe("duplicate");
    expect(b.status).not.toBe("duplicate");
    expect(a.id).not.toBe(b.id);
  });

  it("splits a batched Forward Email payload into one judgement per recipient", async () => {
    const d = deps();
    const payload = fePayload({
      messageId: "<batch@bots.example.com>",
      from: BOT_A,
      to: [SYSTEM, BOT_B, "archive@bots.example.com"],
      recipients: [SYSTEM, BOT_B, "archive@bots.example.com"],
      subject: "batched",
      text: "three recipients share one webhook POST",
    });
    const { httpStatus, results } = await ingestForwardEmail(payload, d);
    expect(httpStatus).toBe(200);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status !== "duplicate")).toBe(true);
    expect(new Set(results.map((r) => r.id)).size).toBe(3);
  });

  it("falls back to sha256(from|subject|date|body) when Message-ID is missing", async () => {
    const d = deps();
    const payload = fePayload({
      messageId: null,
      from: BOT_A,
      to: SYSTEM,
      subject: "no id",
      text: "same body",
      date: "Thu, 19 Nov 2026 12:34:56 +0900",
    });
    const a = await processOne(payload, SYSTEM, d);
    const b = await processOne(payload, SYSTEM, d);
    expect(a.status).toBe("delivered");
    expect(b.status).toBe("duplicate");
    const key = (await d.store.getMessage(a.id))?.dedup_key ?? "";
    expect(key.startsWith("sha256:")).toBe(true);
  });

  it("accepts a realistic Forward Email fixture", async () => {
    const d = deps();
    const { httpStatus, results } = await ingestForwardEmail(fixture, d);
    expect(httpStatus).toBe(200);
    expect(results).toHaveLength(1);
    expect(results[0].recipient).toBe(SYSTEM);
    expect(results[0].status).toBe("delivered");
  });

  it("treats bracket/case/whitespace variants of the same Message-ID + recipient as one message", async () => {
    const d = deps();
    const variants = ["  <ABC@Bots.Example.COM>  ", "abc@bots.example.com", "<abc @bots.example.com>"];
    const results = [];
    for (const [i, messageId] of variants.entries()) {
      const payload = fePayload({ messageId, from: BOT_A, to: SYSTEM, subject: `v${i}`, text: `v${i}` });
      const { httpStatus, results: r } = await ingestForwardEmail(payload, d);
      expect(httpStatus).toBe(200);
      results.push(r[0]);
    }
    expect(results[0].status).toBe("delivered");
    expect(results[1].status).toBe("duplicate");
    expect(results[2].status).toBe("duplicate");
    expect(await d.store.listMessages()).toHaveLength(1);
    expect((await d.store.getMessage(results[0].id))?.dedup_key).toBe(
      "<abc@bots.example.com>|system@bots.example.com",
    );
  });

  it("normalizes Message-ID to a lowercase <id> and keeps clean ids unchanged", () => {
    expect(normalizeMessageId("  <ABC@X.COM>  ")).toBe("<abc@x.com>");
    expect(normalizeMessageId("abc@x.com")).toBe("<abc@x.com>");
    expect(normalizeMessageId("<once@bots.example.com>")).toBe("<once@bots.example.com>");
    expect(normalizeMessageId(" <> ")).toBeNull();
    expect(normalizeMessageId(undefined)).toBeNull();
  });

  it("same logical Message-ID with a different recipient stays distinct", async () => {
    const d = deps();
    const a = await processOne(
      fePayload({ messageId: "<Fan@bots.example.com>", from: BOT_A, to: [SYSTEM, BOT_B], subject: "f", text: "f" }),
      SYSTEM,
      d,
    );
    const b = await processOne(
      fePayload({ messageId: "fan@BOTS.example.com", from: BOT_A, to: [SYSTEM, BOT_B], subject: "f", text: "f" }),
      BOT_B,
      d,
    );
    expect(a.status).not.toBe("duplicate");
    expect(b.status).not.toBe("duplicate");
  });
});
