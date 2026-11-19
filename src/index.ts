import { Hono } from "hono";
import {
  checkConsoleToken,
  consoleUnauthorized,
  messageApi,
  messagesApi,
  renderConsole,
} from "./console.ts";
import { hmacSha256Hex, timingSafeEqual } from "./crypto.ts";
import { d1Exec, storeFromSql } from "./db.ts";
import { DEFAULT_ROUTES_YAML } from "./defaultRoutes.ts";
import { ingestForwardEmail } from "./pipeline.ts";
import { runRetries } from "./retry.ts";
import { parseRoutesYaml } from "./router.ts";
import type { EnvBindings, RouteRule } from "./types.ts";

export interface WorkerEnv extends EnvBindings {
  DB: D1Database;
}

const app = new Hono<{ Bindings: WorkerEnv }>();

function loopToken(env: WorkerEnv): string {
  return env.LOOP_TOKEN || "agentpeer";
}

function loadRoutes(env: WorkerEnv): RouteRule[] {
  const yaml =
    typeof env.ROUTES_YAML === "string" && env.ROUTES_YAML.trim()
      ? env.ROUTES_YAML
      : DEFAULT_ROUTES_YAML;
  return parseRoutesYaml(yaml);
}

function storeOf(env: WorkerEnv) {
  return storeFromSql(d1Exec(env.DB));
}

async function verifyRequest(req: Request, env: WorkerEnv, rawBody: string): Promise<string | null> {
  const key = env.FE_WEBHOOK_SIGNING_KEY;
  if (key) {
    const expected = await hmacSha256Hex(key, rawBody);
    const got = (req.headers.get("x-webhook-signature") ?? "").trim().toLowerCase();
    if (!got || !timingSafeEqual(expected, got.replace(/^sha256=/, ""))) {
      return "bad signature";
    }
  }
  // shortcut: optional IP allowlist when the signing key is not on the plan.
  // upgrade: verify against Forward Email published IPs automatically.
  const allowed = env.FE_ALLOWED_IPS;
  if (allowed) {
    const ip = req.headers.get("cf-connecting-ip") ?? "";
    const ok = allowed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(ip);
    if (!ok) return "ip not allowed";
  }
  return null;
}

app.get("/health", (c) =>
  c.json({ ok: true, service: "agentpeer", status: "MVP in progress, not deployed" }),
);

app.post("/in/fe/:token", async (c) => {
  const token = c.env.INGEST_PATH_TOKEN;
  if (!token || c.req.param("token") !== token) {
    return c.text("not found", 404);
  }
  const raw = await c.req.text();
  const denied = await verifyRequest(c.req.raw, c.env, raw);
  if (denied) return c.text(denied, 401);

  let payload: unknown;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return c.text("invalid json", 400);
  }

  try {
    const result = await ingestForwardEmail(payload, {
      store: storeOf(c.env),
      routes: loadRoutes(c.env),
      env: c.env,
      consoleUrl: new URL("/console", c.req.url).toString(),
      loopToken: loopToken(c.env),
      tenantId: c.env.TENANT_ID || "ounce",
    });
    // Always 200 after a successful store so Forward Email does not retry for days.
    return c.json({ ok: true, results: result.results }, 200);
  } catch (err) {
    console.error("ingest failed", err instanceof Error ? err.message : err);
    return c.text("store failed", 500);
  }
});

app.get("/console", async (c) => {
  if (!checkConsoleToken(c.req.raw, c.env.CONSOLE_TOKEN)) return consoleUnauthorized();
  return renderConsole(storeOf(c.env));
});

app.get("/api/messages", async (c) => {
  if (!checkConsoleToken(c.req.raw, c.env.CONSOLE_TOKEN)) return consoleUnauthorized();
  return messagesApi(storeOf(c.env));
});

app.get("/api/messages/:id", async (c) => {
  if (!checkConsoleToken(c.req.raw, c.env.CONSOLE_TOKEN)) return consoleUnauthorized();
  return messageApi(storeOf(c.env), c.req.param("id"));
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: WorkerEnv, _ctx: ExecutionContext) {
    await runRetries(storeOf(env), {
      routes: loadRoutes(env),
      env,
      loopToken: loopToken(env),
      tenantId: env.TENANT_ID || "ounce",
    });
  },
};
