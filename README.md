# agentpeer

A mail router for agents. It sits in front of bot inboxes, stores each message once, stops reply loops, and hands the rest to the right agent.

에이전트끼리 메일로 핑퐁이 나는 문제를 막는 라우터의 1주 MVP다.

**Status: MVP in progress, not deployed.**

This repository is the start of **Feedbot & agentpeer.cloud**. The worker is real TypeScript with tests. It is not wired to a live domain yet: no DNS or MX changes, no Cloudflare deploy, and no secrets in the repo.

## Why this exists

Agents that talk over email will happily answer each other forever. That is not theoretical. On 19 November 2026, two of our bots exchanged a "No home channel" auto-reply twelve times in a single thread before a human noticed. Forward Email also retries a webhook for days unless it gets an HTTP 200, so the same message can arrive more than once.

agentpeer is the layer that should have been in the middle:

1. Accept the webhook and persist the raw message first, then return **200 quickly**.
2. **Normalize** the Forward Email (mailparser) payload.
3. **Dedup** on `Message-ID + recipient`, or `sha256(from|subject|date|body)` when the id is missing.
4. **Loop guard** — `Auto-Submitted`, `X-Loop`, hop count (`X-Agentpeer-Hop` ≤ 3), a fixed auto-notice list (including "No home channel"), and a rate breaker of **5 messages / 10 minutes / thread** (and 30 / 10 minutes / sender).
5. **Trust** — optional sender allowlist. The body is always marked `untrusted: true`. The router never sends an auto-reply of its own.
6. **Route** from `routes.yaml` to an adapter: `grok_webhook`, `grok_tag`, or `store_only`.
7. **Retry** failed deliveries on a 5-minute cron, up to 3 attempts.

A read-only `/console` page lists what arrived, how it was judged, and whether delivery succeeded. Bodies are rendered as text only, under a strict CSP.

## Architecture

Solid lines are the one-week MVP. Dashed lines are later.

![Architecture — Feedbot & agentpeer.cloud](docs/feedbot-architecture.png)

Feedbot is the later front-end (an X-style feed for bots). The mockup below is illustrative; the Devin card and status numbers are examples, not live data.

![Feedbot UI mockup](docs/feedbot-mockup.png)

```
Forward Email webhook
        │  POST /in/fe/<token>
        ▼
  ingest (store first → 200)
        │
        ├─ normalize
        ├─ dedup
        ├─ loop guard
        ├─ trust
        ├─ routes.yaml
        └─ adapters ── grok_webhook / grok_tag / store_only
                         │
                         └─ retry cron  */5  × 3

D1:  messages · deliveries · routes · events
HTTP:  /console  (read-only)  ·  /api/messages
```

## MVP vs next

| Now (this repo) | Next |
| --- | --- |
| Forward Email webhook in, MX unchanged | Cloudflare Email Routing (after approval, bots subdomain first) |
| `/console` log view | **Feedbot** UI (feed, DMs, mentions, approvals) |
| `grok_webhook`, `grok_tag`, `store_only` | SMTP out, MCP, A2A, **Devin Bot as the first external agent** |
| Loop guard + allowlist | Approval queue for payments, deletes, and mail to humans |

Rollback for a live hook, when one exists, is removing the webhook recipient. Existing mailbox forwards stay in place.

## Development

Requires Node 22+.

```bash
npm install
npm test
```

Copy `routes.example.yaml` and `.env.example` when you run the worker locally. Bindings go in `.dev.vars` (gitignored). `wrangler.toml` uses placeholders (`<ACCOUNT_ID>`, `<D1_DATABASE_ID>`). Do not put tokens, account ids, or personal addresses in the repo.

```bash
npx wrangler dev   # needs a D1 database id; not deployed from this checkout
```

The core (`src/normalize.ts`, `dedup.ts`, `loopGuard.ts`, `trust.ts`, `router.ts`, `pipeline.ts`) is plain TypeScript. Tests run against `node:sqlite` with the same `schema.sql` that D1 will use.

## What this repo will not do

- Change DNS or MX.
- Deploy to Cloudflare for you.
- Ship secrets, API tokens, or real account identifiers.
- Auto-reply to mail. If a message is blocked, it is stored and logged, not answered.

## License

MIT
