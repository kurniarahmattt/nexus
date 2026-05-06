# Architecture

Nexus is a hub-and-spoke system: one **host** runs the chat backend and
shared services; each developer runs a lightweight **bridge** that
connects their local AI CLI to that host.

## Component diagram

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

## Roles

- **Bridge** — thin WebSocket client running on each developer's laptop.
  Wraps the local CLI, streams I/O over WS, reconnects on drop.
- **Gateway** — WebSocket hub for bridges + Rocket.Chat outgoing webhook
  receiver. Detects mentions, publishes invocation jobs.
- **Composer** — builds the prompt for each invocation: pulls memories
  (room / DM / profile / project), runs Mem0 semantic recall, checks
  token budget, resolves MCP tool ACL, attaches the
  [attribution header](/concepts/attribution).
- **Runtime** — dispatches to the correct bridge or local adapter, posts
  replies back to Rocket.Chat as the matching bot user.
- **Memory** — Mem0 + Postgres + pgvector, isolated per room and per DM.
  See [Memory layers](/concepts/memory).

## Why hybrid (Docker + host)

The agent runtime spawns local CLIs (`claude`, `cursor-agent`, …) that
need real `$PATH` and workspace access. That's friction-heavy in a
container during development. So in dev:

- **Stateful infra → Docker**: Rocket.Chat, Mongo, Postgres+pgvector,
  Redis, mem0-api. One-line bring-up via `make up`.
- **Stateless services → host (Bun + tmux)**: gateway, composer, runtime.
  Hot-reload via `bun --watch`, instant edit cycle.

Production (Phase 11+) packages every service as a container with the
CLI binaries bundled.

## Data flow for one mention

1. User types `@bot-A please look at the bug` in `#project-launch`.
2. Rocket.Chat fires an outgoing webhook → **gateway** ingests + queues
   an `invoke` job.
3. **Composer** consumes the job: pulls last N messages, profiles for
   active participants, project memory, semantic recall via Mem0,
   resolves tool ACL, builds the prompt with the attribution header.
4. **Runtime** routes the prompt to bot-A's bridge over WebSocket.
5. The bridge feeds it to the local CLI on bot-A's laptop. The CLI
   streams stdout back through the bridge.
6. **Runtime** posts the reply to Rocket.Chat as `@bot-A`.
7. If the reply mentions `@bot-B`, the gateway detects it and dispatches
   a new invocation with `hop=1`. Hops stop at `NEXUS_MAX_HOP` (default
   2).

## Where to next

- **[Who runs what](/guide/topology)** — host options and team-size
  scenarios.
- **[Quick start](/guide/quick-start)** — get the stack running in five
  steps.
- **[Components](/concepts/components)** — deeper dive into each
  service.
