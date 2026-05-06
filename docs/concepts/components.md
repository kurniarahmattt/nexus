# Components

Nexus is composed of four host services and three infrastructure
containers, plus a per-developer bridge. Each has a narrow
responsibility.

## Gateway (`services/gateway`, port 4000)

**Entry point** for everything inbound: Rocket.Chat outgoing webhooks
plus every developer's bridge WebSocket.

Responsibilities:

- Subscribe to Rocket.Chat events (DDP / webhook) and **ingest** every
  message into Redis (working buffer) + Postgres (`messages` audit
  trail).
- **Detect** bot mentions and DM-to-bot, push an `invoke` job onto
  Redis / BullMQ.
- Serve the **WebSocket hub** for bridges (auth, dispatch, reconnect).
- Provide the **Admin REST API** consumed by the Web UI: login, bridge
  CRUD, MCP server CRUD, agent stats.

## Composer (`services/composer`, port 4001)

The **brain**. Consumes `invoke` jobs and produces the prompt that
will be handed to the runtime.

Pipeline per invocation:

1. Pull the working memory window for the room/DM from Redis.
2. Pull user profiles for active participants.
3. Pull project memory if the room is tagged.
4. Run **Mem0 semantic search** against the latest message (`run_id`
   filter applied).
5. Estimate token usage; if > 70%, trigger compaction inline.
6. Resolve the **MCP tool list** allowed in this room (via
   `room_tool_acl`).
7. Build the final prompt with the
   [attribution header](/concepts/attribution).
8. Hand off to the runtime via Redis.

## Runtime (`services/runtime`, port 4002, host-only)

**Spawner / dispatcher.** Receives prompts from the composer and routes
each to the correct destination:

- **Local CLI** — for built-in agents (`@claude`, `@hermes`, `@cursor`,
  `@gemini`), spawns a PTY using the matching adapter in
  `runtime/src/adapters/`.
- **Remote bridge** — for per-user bridge bots
  (e.g. `@claude-alice-backend`), forwards over the gateway's WebSocket
  hub.

In both cases, output is streamed back chunk-by-chunk and posted to
Rocket.Chat as the matching bot user.

Adapter pattern: each CLI gets its own file under `adapters/` with three
shared concerns — spawn, parse stdout, detect tool_call. See
[Adding a CLI adapter](/reference/adapters) for the recipe.

## Bridge (`packages/nexus-bridge`)

Lightweight WebSocket client that runs on a developer's laptop. It:

- Authenticates to the gateway with a token issued by `make create-bridge`.
- Announces its identity (slug, CLI kind, working directory) on
  connect.
- Forwards prompts received over WS to the local CLI's stdin.
- Streams the CLI's stdout back over WS chunk-by-chunk.
- Auto-reconnects on network drop with backoff.

The bridge is the only piece each developer runs — everything else lives
on the host. See [Add an AI partner](/guide/bridges).

## Mem0 API (`services/mem0-api`, port 4100, Docker)

Python sidecar wrapping [Mem0](https://mem0.ai) with a thin FastAPI
surface (add / search / delete). Composer talks to it over HTTP.

We chose to keep Mem0 in its native Python (rather than port to Bun)
because the upstream extraction pipeline is Python-only for full feature
parity. Loose coupling via HTTP keeps the rest of the stack TypeScript.

## Postgres + pgvector (port 5433)

Single source of truth for:

- **Identity**: `users`, `agents`, `rooms`, `projects`.
- **Audit / replay**: `messages`.
- **Episodic memory**: `summaries` (with `vector(1536)` embeddings).
- **Landmarks**: `landmarks` (pinned messages, never compacted).
- **Structured facts**: `facts` (per-user, per-project, per-room).
- **MCP**: `mcp_servers`, `room_tool_acl`.
- **Audit trail**: `audit_log`.

See [DATA-MODEL on GitHub](https://github.com/kurniarahmattt/nexus/blob/main/PLANNING.md#51-postgres-schema-sketch)
for the full schema.

## Redis (port 6380)

Three concerns:

1. **Working memory** — per-room rolling buffer of the last N messages.
2. **Job queue** (BullMQ) — `invoke` and `execute` jobs flowing from
   gateway to composer to runtime.
3. **Distributed locks** — per-room mutex when two invokes hit the same
   room concurrently.

## Rocket.Chat (port 3000)

The chat UI. Nexus does **not** fork Rocket.Chat — it consumes the REST
+ Realtime APIs. Every AI agent gets a bot user in Rocket.Chat (created
during `make bootstrap` or `make create-bridge`).

## Web UI (`services/web`, served by gateway at `/admin/*`)

Vite + React 19 + Tailwind v4 admin app. Provides:

- Login (uses `NEXUS_ADMIN_TOKEN`).
- Bridge management (create, edit persona, list connected, regenerate
  token).
- MCP server management.
- Channel + user listing.

Built artifact lives in `services/web/dist/` and is served by the
gateway under `/admin/*`.
