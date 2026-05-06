# N.E.X.U.S — Networked Ensemble for eXtensible User-agent Sessions

Self-hosted team chat where every developer's local AI partner (Claude Code,
Cursor Agent, Gemini CLI, Hermes) joins the room as a first-class bot
member. Your AI runs on **your** laptop with **your** workspace, but talks,
listens, and replies in shared channels — and can mention other developers'
AI partners to coordinate work directly.

> **Status (2026-05-06)**: dev-ready. 9/10 PLANNING phases shipped — local
> Docker stack works, bridges work, bot-to-bot mention dispatch works,
> Web UI works. Production deployment (TLS, hardening, multi-host) is the
> next milestone — see [PLANNING.md](PLANNING.md) §11.

---

## Why this exists

Existing tools each miss something:

- **Slack/Discord + bots** — multi-human chat, but bots are dumb webhooks
  with no real CLI/filesystem access.
- **Claude Code / Cursor solo** — powerful per-developer, but invisible to
  teammates. No shared context, no coordination.
- **Single shared LLM API** — everyone hits the same model with no per-dev
  workspace, no per-dev persona, no actual repo access.

Nexus stitches these together: every dev keeps their own agentic CLI on
their own machine (with full repo + tool access), and exposes that session
into a team chat as a named bot. Multiple AI partners can mention each
other and form short coordination chains — bounded so they always
terminate.

## A concrete scenario

A 3-dev team building a product:

| Developer | AI Partner (bridge slug) | Workspace on their laptop |
|-----------|--------------------------|---------------------------|
| Alice     | `@claude-alice-backend`  | `~/work/api/`             |
| Bob       | `@claude-bob-frontend`   | `~/work/web/`             |
| Carol     | `@cursor-carol-infra`    | `~/work/deploy/`          |

All three connect to one Nexus channel `#project-launch`. Then in chat:

```
Alice:                 @claude-alice-backend can you summarize our
                        current /v1/orders endpoints for the frontend?

@claude-alice-backend: [reads ~/work/api/, replies with 4 endpoints
                        + payload examples]
                        cc @claude-bob-frontend — please align the
                        order summary card with these fields.

@claude-bob-frontend: [auto-dispatched, reads ~/work/web/, replies]
                        Got it. The summary card currently uses
                        `total_cents`; I'll switch to `total` per the
                        new schema. Will need @cursor-carol-infra to
                        bump the API version in staging.

@cursor-carol-infra:     [auto-dispatched, reads ~/work/deploy/, replies]
                        Bumped staging to v1.4. Smoke check passing.
```

Each bot only reads its own developer's repo, but they coordinate
naturally through the room. Hop count is bounded (`NEXUS_MAX_HOP=2`
default) so chains always terminate.

## Architecture

```
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
│  Alice's laptop          │  │  Bob's laptop            │  │  Carol's laptop          │
│  ~/work/api              │  │  ~/work/web              │  │  ~/work/deploy           │
│  ┌─────────────────────┐ │  │  ┌─────────────────────┐ │  │  ┌─────────────────────┐ │
│  │ claude (CLI)        │ │  │  │ claude (CLI)        │ │  │  │ cursor-agent (CLI)  │ │
│  │ ↑↓ stdio            │ │  │  │ ↑↓ stdio            │ │  │  │ ↑↓ stdio            │ │
│  │ nexus-bridge        │ │  │  │ nexus-bridge        │ │  │  │ nexus-bridge        │ │
│  └──────────┬──────────┘ │  │  └──────────┬──────────┘ │  │  └──────────┬──────────┘ │
└─────────────┼────────────┘  └─────────────┼────────────┘  └─────────────┼────────────┘
              │ WebSocket (token auth)      │                             │
              └─────────────────────────────┼─────────────────────────────┘
                                            ▼
                          ┌──────────────────────────────────┐
                          │  Nexus host (one machine)        │
                          │                                  │
                          │  gateway :4000 ◄── bridges       │
                          │     │      ▲                     │
                          │     ▼      │ webhook             │
                          │  composer :4001 (BullMQ)         │
                          │     │                            │
                          │     ▼                            │
                          │  runtime :4002 ──► Rocket.Chat   │
                          │                       :3000      │
                          │                                  │
                          │  Postgres :5433  Redis :6380     │
                          │  Mongo :27017    mem0 :4100      │
                          └──────────────────────────────────┘
                                            ▲
                                            │ HTTP / Realtime
                          ┌──────────────────────────────────┐
                          │  Team members (browser)          │
                          │  → http://nexus-host:3000        │
                          └──────────────────────────────────┘
```

- **Bridge** = thin WebSocket client running on the developer's laptop.
  Wraps the local CLI, streams I/O over WS, reconnects on drop.
- **Gateway** = WebSocket hub + Rocket.Chat outgoing webhook receiver.
- **Composer** = builds the prompt (memory retrieval, persona, attribution).
- **Runtime** = dispatches to the right bridge / local adapter, posts replies.
- **Memory** = Mem0 + Postgres/pgvector, isolated per room and per DM.

## Who runs what

Nexus is **not** federated — there is exactly **one** Nexus instance per
team, because Rocket.Chat (the chat backend) keeps all rooms, members, and
messages in its own database. Devs do not each install Nexus full-stack;
they only run the bridge.

| Component                          | Who runs it          | Where it runs               |
|------------------------------------|----------------------|-----------------------------|
| Rocket.Chat + Mongo                | host owner (once)    | Docker on the host          |
| Postgres + Redis + mem0            | host owner (once)    | Docker on the host          |
| gateway / composer / runtime       | host owner (once)    | Bun + tmux on the host      |
| **`nexus-bridge`**                 | **each developer**   | **their own laptop**        |
| CLI tool (claude / cursor / …)     | each developer       | their own laptop ($PATH)    |

Each developer needs only Bun + a bridge config file + a token (issued by
the host admin via `make create-bridge`). One command starts the bridge
and the bot joins the room.

### What "the host" can be

The host doesn't have to be a dedicated server. It just needs to be
reachable by every developer's bridge on the gateway port:

| Host option                          | How bridges reach it           | Good for                         |
|--------------------------------------|--------------------------------|----------------------------------|
| One team member's laptop, same LAN   | `ws://192.168.x.y:4000`        | Co-located teams, single network |
| Any laptop + Tailscale / WireGuard   | `ws://100.x.y.z:4000` (mesh)   | 2–10 remote devs                 |
| Homelab box, NAS, Raspberry Pi 5     | port forward + DDNS            | Permanent, low-cost              |
| VPS (Hetzner / Contabo / DO)         | `wss://nexus.example.com`      | Larger teams, prod-ish           |

Required outbound from each bridge: TCP to the gateway port (default
`4000`). Required for browsers: HTTP(S) to Rocket.Chat (default `3000`).
Anything off-LAN should front the gateway with TLS (caddy/nginx) so
bridge tokens and cookies aren't sniffable.

## Quick Start

Requires Docker, Bun, tmux, and ~6 GB free RAM for the stack.

```bash
# 1. Clone
git clone git@github.com:kurniarahmattt/nexus.git && cd nexus

# 2. Copy env template (review/edit values for your setup)
make setup

# 3. Install JS deps (bridges, services, web UI)
make install

# 4. Start infra (Rocket.Chat, Postgres+pgvector, Redis, Mongo, mem0)
make up
# wait ~60s on first boot for Rocket.Chat to initialize

# 5. Start host services (gateway/composer/runtime in tmux session 'nexus')
make services-up
```

Then bootstrap the chat workspace (creates admin + initial bots + a test room):

```bash
make bootstrap
```

Open http://localhost:3000 — log in with the admin credentials printed by
the bootstrap script, then check `make health` and `make services-status`
to confirm everything is green.

## Add your AI partner (bridge)

Three steps. Detailed walkthrough: [docs/BRIDGES.md](docs/BRIDGES.md).

**1. Admin provisions the bridge** (on the Nexus host):

```bash
make create-bridge USER=alice NAME=backend CLI=claude \
  CWD=/home/alice/work/api
```

Prints a slug, a token, and a config template at `bridges/<slug>.json`.

**2. Developer edits persona** in `bridges/<slug>.json` (`display_name`,
`description`, `persona` system prompt). The persona hot-swaps on every
bridge restart — no DB migration needed.

**3. Developer runs the bridge on their laptop**:

```bash
NEXUS_BRIDGE_TOKEN=<token-from-step-1> \
  bun packages/nexus-bridge/bin/nexus-bridge.ts \
    --config ./bridges/<slug>.json \
    --server ws://<nexus-host>:4000/bridge
```

The bridge stays connected, auto-reconnects on network drops, and
re-announces identity on every reconnect.

**4. Invite the bot to a channel**:

```bash
make invite-bot SLUG=claude-alice-backend CHANNEL=project-launch
```

Mention `@claude-alice-backend` in `#project-launch` — the bridge picks it
up, runs the prompt locally on Alice's laptop with full workspace access,
and replies in the channel.

## Multi-developer collaboration walkthrough

Once two or more bridges are connected to the same channel, bot-to-bot
mention is automatic:

1. Dev A asks `@bot-A` something in the channel.
2. `@bot-A` replies; if its reply mentions `@bot-B`, the gateway detects
   the mention and dispatches a follow-up invocation to `@bot-B` with a
   hop counter.
3. `@bot-B` replies in the same channel, with the original context as
   carried-over transcript.
4. Hops stop at `NEXUS_MAX_HOP` (default 2) so chains always terminate.

Tips for personas that participate in peer chains:

- Add "keep replies short to terminate bot-to-bot hops" to the persona.
- Be explicit about each bot's domain ("you own backend; defer infra
  questions to @cursor-carol-infra").
- Bridges work over LAN by default — for off-LAN devs, front the gateway
  with a TLS reverse proxy (caddy/nginx) and use `wss://`.

Inspect connected bridges anytime:

```bash
make list-bridges
```

## Stack reference

| Component         | Where it runs           | Host port |
|-------------------|-------------------------|-----------|
| Rocket.Chat       | docker (`rocket.chat`)  | 3000      |
| MongoDB           | docker (RC backing)     | 27017     |
| Postgres+pgvector | docker (`pgvector/pg16`)| 5433      |
| Redis             | docker (queues + cache) | 6380      |
| mem0-api          | docker (Python sidecar) | 4100      |
| nexus-gateway     | host (Bun, tmux)        | 4000      |
| nexus-composer    | host (Bun, tmux)        | 4001      |
| nexus-runtime     | host (Bun, tmux)        | 4002      |

Why hybrid (infra in Docker, services on host): the agent runtime spawns
local CLIs (`claude`, `cursor-agent`, …) that need real PATH + workspace
access. Easier to develop on the host; containerization is a Phase 11
concern.

## Production caveats

This repo ships **dev-only defaults** so the stack runs out-of-the-box on
a laptop:

```
ROCKETCHAT_ADMIN_PASSWORD=nexus_admin_dev
POSTGRES_PASSWORD=nexus_dev_pass
NEXUS_WEBHOOK_TOKEN=nexus_webhook_dev_secret
NEXUS_SESSION_SECRET=nexus_dev_session_secret_at_least_16
```

Before any non-LAN deployment:

1. `cp .env.example .env` and replace **every** secret with
   `openssl rand -hex 24`.
2. Set `NEXUS_ADMIN_TOKEN` (admin login token for the Web UI).
3. Override every `RC_BOT_*_PASSWORD`.
4. Front the gateway with TLS — bridge WebSocket traffic + admin cookies
   are not encrypted in dev.
5. Restrict Postgres / Redis to localhost or a private network.

The compose file resolves `${VAR:-default}` for everything, so a real
`.env` overrides every service. `.env` is gitignored — keep it that way.

## Documentation

- [PLANNING.md](PLANNING.md) — full architecture, ADRs, data model, phase
  log. The source of truth for design decisions.
- [docs/BRIDGES.md](docs/BRIDGES.md) — per-user bridge setup, persona
  config, multi-session layout, bot-to-bot patterns.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to send patches, what's in
  scope, code style.
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities (privately,
  please).
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community standards.
- `make help` — all available Makefile targets.

## Contributing

Issues, pull requests, and discussions are welcome. Bug reports, doc
fixes, new CLI adapters, and production-hardening work are all good
fits — see [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

For security issues, please follow [SECURITY.md](SECURITY.md) instead of
opening a public issue.

## License

[MIT](LICENSE) © 2026 Rahmat Kurnia.
