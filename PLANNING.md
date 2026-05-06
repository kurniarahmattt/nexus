# N.E.X.U.S — Sharing Session Agents
## Full Planning Document

> **Status**: v0.2 — Checkpoint Approved, ready to scaffold Phase 0
> **Date**: 2026-04-21
> **Maintainer**: Rahmat Kurnia (project lead)
> **Codename**: **N.E.X.U.S** — **N**etworked **E**nsemble for e**X**tensible **U**ser-agent **S**essions
> **License**: [MIT](LICENSE) — © Rahmat Kurnia

---

## 0. Context & Goals

**Vision.** Build a web-based chat platform that lets **human teams
collaborate alongside AI Agents** in a shared *room*. AI Agents here are
not plain chatbot APIs — they are **wrappers around AI CLI tools** (Claude
Code, Cursor Agent, Gemini CLI, Hermes, Goose, OpenClaw, etc.) with real
execution access (filesystem, shell, tool calling).

**Core use cases**:
- A developer team creates a room for a project.
- One or more AI Agent bots are added to the room as "team assistants".
- Team members can talk to each other, mention a bot for help, or simply
  observe other users' conversations with the bot.
- Each user can also DM a bot privately — the bot must distinguish DM
  context from room context.
- The bot must **remember the entire flow** (group + DM), understand
  attribution ("who said what"), and have short-term + long-term memory
  with automatic compaction when context bloats.

**Problem solved**: today no single tool brings together (a) multi-human
team chat, (b) AI agents that wrap CLIs, (c) sophisticated memory, and
(d) skill / tool management. Existing tooling always misses one of these
four dimensions.

---

## 1. Architecture Decisions Summary (Brief ADRs)

| # | Decision | Rationale |
|---|---|---|
| ADR-001 | **Rocket.Chat** as the chat UI | Most mature Apps-Engine for custom bot integration; complete REST + Realtime API; UIKit supports interactive buttons (for tool approval); official Docker image; MIT licensed. |
| ADR-002 | **Mem0** as the memory extraction & retrieval layer | State of the art (2026) for agent memory; self-hostable; agent-runtime-agnostic (matters because we swap CLI agents); built-in user_id scoping. |
| ADR-003 | **Postgres + pgvector** as the single storage (structured + vector) | Service consolidation (one DB for summaries, facts, vectors). Fewer components than Mem0 + Qdrant + Postgres. pgvector is production-ready in 2026. |
| ADR-004 | **Redis** for working memory + job queue | Industry standard for ephemeral state and background jobs. |
| ADR-005 | **Bun + TypeScript** for custom services (Gateway, Composer, Runtime) | High performance, native TypeScript, fast startup — well suited to async-I/O-heavy services. |
| ADR-006 | **Hybrid deploy in dev**: stateful infra in Docker, agent runtime on the host | CLI tools (claude-code, cursor, hermes) live on the host. Containerizing the agent runtime in dev is complex (binary path, workspace mount, OS mismatch). Defer to production. |
| ADR-007 | **MCP (Model Context Protocol)** for the tool layer | It is the standard; Claude Code is MCP-native; easy to add new tools without changing the runtime. |
| ADR-008 | **Fresh memory isolation** | Do NOT touch any other tooling's memory server / knowledge graph on the host. Nexus memory lives in its own Postgres container. |
| ADR-009 | **Skill registry** — OpenSpace integration deferred to Phase 8 | Early phases focus on memory + routing. Skill integration adds complexity that is not yet needed. |
| ADR-010 | **CLI agents v1: `claude` + `hermes` only** | Start minimal. `cursor-agent` and `gemini` are added in Phase 5 (Multi-Agent Expansion) once the adapter pattern is stable. |
| ADR-011 | **Workspace path via env var** (`NEXUS_WORKSPACE_ROOT`) | Must be set as an absolute path in `.env`; no default fallback. Composer fails fast if the env var is missing. |
| ADR-012 | **License: MIT** | Public release; permissive license selected for maximum compatibility. © Rahmat Kurnia. |

---

## 2. v1 Scope & Non-Goals

### In-Scope v1

- Web chat UI (via Rocket.Chat) with rooms, DMs, threads, and mentions.
- Per-AI-agent bot identity (one bot user per CLI, e.g. `@claude`,
  `@cursor`, `@gemini`, `@hermes`).
- Message routing: `@mention` in a room → invoke agent; DM to a bot →
  invoke agent privately.
- Explicit attribution: the bot always knows `{user, room, timestamp}`
  for every message.
- Memory layers: working (Redis), episodic (Postgres summaries), semantic
  (pgvector via Mem0), structured (Postgres tables).
- Scoped memory: per-room, per-DM, per-user-profile, per-project.
- Compaction: automatic when token budget reaches ≥ 70% of the agent's
  context window, with landmark preservation.
- CLI agent runtime pool v1: **`claude` + `hermes`** (adapter pattern
  ready to extend to `cursor-agent`, `gemini`, etc. in Phase 5).
- Tool layer: MCP server registry, per-room tool whitelist.
- Basic ACL: a user cannot access another user's DM via a bot; DM memory
  does not leak into rooms.
- Deploy: `docker compose up` on a host (laptop / homelab / VPS).

### Non-Goals v1 (explicitly excluded)

- Native mobile app (use the existing Rocket.Chat mobile app if needed).
- Voice/video calls.
- End-to-end encryption between users (rely on Rocket.Chat's default TLS).
- Multi-tenant SaaS (v1 is single-tenant, one team per Nexus instance).
- Fine-grained per-user billing / cost tracking.
- Automatic agent-to-agent orchestration (use existing ClawTeam if you
  need parallel agent orchestration).
- Production hardening (backup, DR, HA) — that becomes Phase 10+ when
  moving to a server.

---

## 3. System Architecture

### 3.1 Component Diagram

```
                    ┌─────────────────────────────────┐
                    │         User (browser)          │
                    └────────────────┬────────────────┘
                                     │ HTTPS / WebSocket
                                     ▼
          ┌──────────────────────────────────────────────────┐
          │          Rocket.Chat  (Docker, port 3000)        │
          │   rooms • DMs • threads • mentions • file UI     │
          │   bot users: @claude, @cursor, @gemini, @hermes  │
          └────────────────────┬─────────────────────────────┘
                               │ Realtime API (DDP/WS) + Webhooks
                               ▼
     ┌─────────────────────────────────────────────────────────┐
     │          nexus-gateway  (Bun, host:4000)                │
     │   · subscribe message events (global)                   │
     │   · ingest raw → working memory (Redis)                 │
     │   · detect bot-mention / DM-to-bot                      │
     │   · publish invoke job → Redis queue                    │
     └────────────────────┬────────────────────────────────────┘
                          │ Redis Streams / BullMQ
                          ▼
     ┌─────────────────────────────────────────────────────────┐
     │        nexus-composer  (Bun, host:4001)                 │
     │   · fetch scoped memories (room / DM / profile / proj)  │
     │   · hit Mem0 for semantic recall                        │
     │   · check token budget → trigger compactor if needed    │
     │   · resolve tools (MCP registry) + ACL per-room         │
     │   · build prompt with attribution header                │
     │   · handoff to runtime                                  │
     └────────────────────┬────────────────────────────────────┘
                          │ Unix socket / local HTTP
                          ▼
     ┌─────────────────────────────────────────────────────────┐
     │       nexus-runtime  (Bun, host:4002, HOST process)     │
     │   agent pool: PTY wrappers for CLI tools                │
     │   · claude-code  · cursor-agent  · gemini  · hermes     │
     │   · stream stdout → Rocket.Chat channel (as bot)        │
     │   · capture tool_call events → MCP                      │
     └────┬──────────────────┬────────────────────┬────────────┘
          │                  │                    │
          ▼                  ▼                    ▼
  ┌───────────────┐  ┌────────────────┐  ┌────────────────────┐
  │  Postgres +   │  │  Redis         │  │  MCP servers       │
  │  pgvector     │  │  (working mem, │  │  (filesystem, web, │
  │  (Docker)     │  │   queue, lock) │  │   bash, git, ...)  │
  │               │  │                │  │                    │
  │  · mem0 store │  │                │  │  host processes    │
  │  · summaries  │  │                │  │                    │
  │  · facts      │  │                │  │                    │
  │  · landmarks  │  │                │  │                    │
  │  · acl        │  │                │  │                    │
  └───────────────┘  └────────────────┘  └────────────────────┘

  ┌─────────────────┐
  │  MongoDB        │ ← internal to Rocket.Chat; we don't touch it directly
  │  (Docker)       │
  └─────────────────┘
```

### 3.2 Per-Component Notes

**Rocket.Chat** — UI & user management. We **do not fork** Rocket.Chat;
we consume its API. Each AI agent has one bot user in Rocket.Chat
(created via the admin API at bootstrap).

**nexus-gateway** — entry point. Subscribes to the Rocket.Chat Realtime
API (DDP over WebSocket) and captures **all** messages (including
user-to-user messages without mentions). Its main jobs:
1. *Ingest*: store the message into Redis working memory with full
   attribution.
2. *Detect invocation*: if the message mentions a bot or is a DM to a
   bot, push a job onto the queue.
3. *Backpressure*: per-user, per-room rate limiting.

**nexus-composer** — the brain. When an invoke job arrives:
1. Pull working memory (last N messages) for `{room_id | dm_id}`.
2. Pull user profiles for all participants active in that window.
3. Pull project memory if the room is tagged to a project.
4. Run a semantic search via Mem0 for "what we discussed before" relevant
   to the latest question.
5. Check the token budget. If > 70%, trigger compaction inline (sync) for
   the window about to be used (or use a precomputed summary if one
   already exists).
6. Resolve the tool list from the MCP registry + filter by per-room ACL.
7. Compose the final prompt with an explicit attribution header.
8. Send to the runtime.

**nexus-runtime** — spawner & PTY manager. **Must run on the host**, not
in a container, because it needs access to CLI agent binaries and the
user's filesystem. Pool management:
- One agent = one long-running PTY process OR ephemeral per-turn
  (decision: **ephemeral in v1** — simpler; long-running in v2 to reduce
  latency).
- Stream stdout line-by-line → post to Rocket.Chat as the matching bot
  user (via REST API).
- Detect tool_call patterns from stdout (each CLI has its own format —
  needs an adapter).

**Postgres + pgvector** — single storage. Schema split per concern (see
§5.1).

**Redis** — (a) working memory rolling buffer, (b) job queue (BullMQ),
(c) distributed lock when two invokes hit the same room concurrently.

**MCP servers** — tool providers. Standard MCP; run as separate host
processes. Registry lives in Postgres (`mcp_servers` + `room_tool_acl`
tables).

---

## 4. Tech Stack

### 4.1 Runtime & Language

| Area | Choice | Target version |
|---|---|---|
| Chat UI | Rocket.Chat | latest stable (6.x) |
| Mongo (for Rocket.Chat) | MongoDB | 7.x |
| Custom services | Bun + TypeScript | Bun ≥ 1.2 |
| Main DB | Postgres + pgvector | 16 + pgvector 0.7 |
| Ephemeral | Redis | 7-alpine |
| Memory layer | Mem0 (Python) | latest, runs as a sidecar service |
| Job queue | BullMQ (over Redis) | latest |
| Tool protocol | MCP | latest spec |

### 4.2 Why Bun instead of Node?

- Fast startup (matters for CLI wrappers that spawn frequently).
- Native TypeScript execution without a build step.
- Built-in SQLite available for local dev caching.
- Compatible with the npm package ecosystem.

### 4.3 Why Mem0 stays in Python instead of porting to TypeScript?

Upstream Mem0 is Python-only for its full feature set. We use it as a
**microservice** (Python/FastAPI) packaged as a container; Bun services
consume it over HTTP. Loose coupling.

### 4.4 Library list (indicative)

**Gateway / Composer / Runtime (Bun)**:
- `@rocket.chat/sdk` or `ddp-client` (realtime)
- `ioredis`, `bullmq`
- `pg` driver
- `zod` (schema validation)
- `pino` (logging)
- `hono` (internal HTTP endpoints)
- `node-pty` (PTY for CLI spawn)

**Mem0 service (Python)**:
- `mem0ai`
- `fastapi`, `uvicorn`
- `psycopg[binary]`

---

## 5. Data Model & Memory Design

### 5.1 Postgres Schema (sketch)

```sql
-- Identity & scoping
CREATE TABLE users (
  id            UUID PRIMARY KEY,
  rocketchat_id TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  email         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE agents (
  id            UUID PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,       -- 'claude-code', 'cursor', ...
  display_name  TEXT NOT NULL,
  cli_command   TEXT NOT NULL,              -- 'claude', 'cursor-agent', ...
  rocketchat_bot_id TEXT NOT NULL,
  config_json   JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE rooms (
  id               UUID PRIMARY KEY,
  rocketchat_rid   TEXT UNIQUE NOT NULL,
  kind             TEXT CHECK (kind IN ('room','dm')) NOT NULL,
  project_id       UUID REFERENCES projects(id),
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE projects (
  id           UUID PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  description  TEXT,
  workspace_path TEXT  -- path on the host for the agent workspace
);

-- Working memory (short rolling buffer) — actually lives in Redis;
-- this table is the archival audit trail
CREATE TABLE messages (
  id             BIGSERIAL PRIMARY KEY,
  rocketchat_mid TEXT UNIQUE NOT NULL,
  room_id        UUID REFERENCES rooms(id),
  sender_user_id UUID REFERENCES users(id),
  sender_agent_id UUID REFERENCES agents(id),  -- NULL when sender is a user
  text           TEXT,
  metadata       JSONB,                        -- attachments, thread parent, reactions
  ts             TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON messages (room_id, ts DESC);

-- Episodic: hierarchical summaries
CREATE TABLE summaries (
  id          BIGSERIAL PRIMARY KEY,
  room_id     UUID REFERENCES rooms(id),
  tier        TEXT CHECK (tier IN ('thread','session','day','week')),
  start_ts    TIMESTAMPTZ NOT NULL,
  end_ts      TIMESTAMPTZ NOT NULL,
  summary     TEXT NOT NULL,
  embedding   vector(1536),
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON summaries USING ivfflat (embedding vector_cosine_ops);

-- Landmark: messages that are never compacted (decisions, specs,
-- important code)
CREATE TABLE landmarks (
  id          BIGSERIAL PRIMARY KEY,
  message_id  BIGINT REFERENCES messages(id),
  kind        TEXT,            -- 'decision','spec','code','link'
  reason      TEXT,
  pinned_at   TIMESTAMPTZ DEFAULT now()
);

-- Structured facts (per-user, per-project)
CREATE TABLE facts (
  id         BIGSERIAL PRIMARY KEY,
  scope_kind TEXT CHECK (scope_kind IN ('user','project','room')),
  scope_id   UUID NOT NULL,
  key        TEXT NOT NULL,
  value      JSONB NOT NULL,
  source_message_id BIGINT,
  confidence REAL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (scope_kind, scope_id, key)
);

-- MCP registry
CREATE TABLE mcp_servers (
  id          UUID PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  command     TEXT NOT NULL,
  args        JSONB,
  env         JSONB
);

CREATE TABLE room_tool_acl (
  room_id       UUID REFERENCES rooms(id),
  mcp_server_id UUID REFERENCES mcp_servers(id),
  allowed_tools TEXT[],     -- subset, or NULL = all
  PRIMARY KEY (room_id, mcp_server_id)
);
```

### 5.2 Memory Namespacing (Mem0)

Mem0 natively supports `user_id`, `agent_id`, `run_id`, and `metadata`.
Our convention:

| Scope | user_id | agent_id | run_id | metadata.visibility |
|---|---|---|---|---|
| Room message | `<user_uuid>` | `<agent_slug>` | `room:<room_uuid>` | `public` |
| DM message | `<user_uuid>` | `<agent_slug>` | `dm:<user_uuid>:<agent_slug>` | `private` |
| User profile | `<user_uuid>` | `<agent_slug>` | `profile:<user_uuid>` | `shared` |
| Project context | `*` (broadcast) | `<agent_slug>` | `project:<project_uuid>` | `shared` |

**Retrieval rule when an agent responds in room X**:
```
filter = run_id IN ('room:<X>', 'profile:<participant_1>', ..., 'project:<Y>')
       AND visibility IN ('public','shared')
```

**Retrieval rule when an agent responds in a DM with user U**:
```
filter = run_id IN ('dm:<U>:<agent>', 'profile:<U>', 'project:<Y>')
       AND (visibility = 'private' AND user_id = <U>)
         OR visibility = 'shared'
```

ACL is **hard-enforced in the composer**, not by relying on the prompt
to the agent.

### 5.3 Attribution Format (prompt injection)

Every transcript handed to an agent always carries a header:

```
[SESSION CONTEXT]
Room: #auth-team (project: saga-ai)
Participants: Andi (backend lead), Budi (frontend), G.I.N.G
You are: @claude (Claude Code CLI agent)
Time: 2026-04-21 14:02 Asia/Jakarta

[RECALL — from long-term memory]
- Andi previously stated a preference for 30 min JWT expiry (fact, 2026-04-15, DM)
- Project saga-ai uses NestJS + Prisma (project memory)

[LANDMARKS — pinned decisions]
- [2026-04-10] Team agreed on refresh-token rotation (by Budi)

[EPISODIC SUMMARY — last session]
Yesterday Andi & Budi discussed a race-condition bug in the auth
middleware; Andi is investigating, not yet resolved.

[RAW TRANSCRIPT — most recent 40 messages]
[14:02 | Andi] @claude why is the token expiry only 15 minutes?
[14:02 | Budi] I'd suggest 30 minutes
[14:03 | Andi] yes, users complained

[CURRENT INVOCATION]
Respond to Andi and Budi in room #auth-team.
```

The format is explicit, deterministic, and digestible by any CLI agent
without prompt-engineering tricks.

### 5.4 Compaction Engine

**Trigger**: estimated token window > 70% of the agent's context budget.

**Algorithm**:
1. Identify the window to compact (typically the oldest messages that
   don't yet have a summary).
2. Detect **landmarks** in the window (heuristics: contains "decision:",
   "spec:", a code block ≥ 20 lines, an `@mention` plus an imperative
   verb, links to specs). Auto-pin them into the `landmarks` table.
3. Separate landmark messages from regular messages.
4. Send the non-landmarks to an LLM summarizer (prompt: "Extract facts,
   decisions, action items, unresolved questions. Preserve speaker
   attribution.").
5. Store the result in the `summaries` table with an embedding.
6. On the next compose: replace the old window with `summary + landmarks
   full text`.

**Tier cascade**:
- Message → Thread summary (when the thread closes or > 50 messages)
- Thread → Session summary (after ~1 hour of inactivity)
- Session → Day summary (nightly job)
- Day → Week summary (weekly job)

The longer ago, the coarser the resolution. There is always a **vector
search fallback** if the user asks for older details ("recall the
discussion from <date>").

---

## 6. Main Flows

### 6.1 Flow A — User-to-User Chat (no bot mention)

```
User A sends a message in #auth-team
  └─► Rocket.Chat broadcasts to peers + emits a DDP event
        └─► nexus-gateway receives the event
              └─► ingest: write to Redis working buffer + Postgres messages
              └─► NOT an invoke trigger (no mention)
```
Working memory is updated; the bot "listens" without responding.

### 6.2 Flow B — User Mentions a Bot in a Room

```
User A: "@claude please check the bug in auth.ts"
  └─► gateway detects @claude mention
        └─► ingests message to working memory
        └─► publishes 'invoke' job onto the Redis queue
              {agent: 'claude-code', room_id, trigger_msg_id}
  └─► composer picks up the job
        ├─► fetch working memory (last 40 msg)
        ├─► fetch profiles of active users (A, plus others)
        ├─► semantic recall via Mem0 (query: latest message)
        ├─► fetch project memory
        ├─► token estimate → if > 70%, trigger inline (sync) compaction
        ├─► resolve MCP tools allowed in this room
        ├─► build prompt with attribution header
        └─► publishes 'execute' to runtime
  └─► runtime spawns a claude-code PTY with the prompt
        ├─► streams stdout chunk by chunk:
        │     ├─► posts to Rocket.Chat as @claude (via REST API)
        │     └─► ingests the reply into working memory + Mem0
        ├─► detects tool_call patterns
        │     ├─► requests approval (UIKit button) if the tool is gated
        │     └─► executes via the MCP server, streams output back to PTY stdin
        └─► PTY exits → final flush
```

### 6.3 Flow C — User DMs a Bot

```
User A opens a DM with @claude and sends a message
  └─► gateway detects: room.kind = 'dm' AND counterparty = agent
        └─► invoke, run_id = 'dm:A:claude-code'
  └─► composer: narrow scope (DM memory + A's profile + project if tagged)
  └─► runtime: spawns and replies in the DM channel
```
DM memory stays isolated; it **does not leak** into public rooms.

### 6.4 Flow D — Scheduled Compaction

```
Cron job every hour:
  └─► scan rooms active in the last hour
  └─► for each room, if there is a window without a summary:
        ├─► extract landmarks
        ├─► summarize non-landmarks
        └─► store summary + embedding
```

### 6.5 Flow E — Add a Bot to a New Room

```
Admin creates a room in Rocket.Chat, invites @claude
  └─► gateway detects 'ru' (room update) event
        └─► upsert into the rooms table
        └─► default ACL: project memory = NULL until tagged
        └─► default tools: a basic subset (file read only, no exec)
  └─► admin runs the slash command /nexus attach-project saga-ai
        └─► sets rooms.project_id and expands the tool ACL
```

---

## 7. Repo Layout

```
nexus/
├── README.md
├── PLANNING.md                     ← this document
├── docker-compose.yml              ← development stack
├── docker-compose.prod.yml         ← future, production variant
├── .env.example
├── Makefile                        ← helper: make up / down / logs / psql
│
├── services/
│   ├── gateway/                    ← Bun service
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── rocketchat/         ← DDP client, message subscribe
│   │   │   ├── ingest/             ← working memory writer
│   │   │   ├── detect/             ← mention/DM detection
│   │   │   └── queue/              ← BullMQ producer
│   │   ├── package.json
│   │   └── Dockerfile              ← optional; dev runs on host
│   │
│   ├── composer/                   ← Bun service
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── memory/             ← clients: redis, pg, mem0
│   │   │   ├── compactor/          ← landmark detection + summarizer
│   │   │   ├── acl/                ← scope filter enforcement
│   │   │   ├── prompt/             ← attribution header builder
│   │   │   └── registry/           ← MCP tool resolver
│   │   └── package.json
│   │
│   ├── runtime/                    ← Bun service, HOST-ONLY
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── pool/               ← PTY lifecycle
│   │   │   ├── adapters/
│   │   │   │   ├── claude-code.ts  ← parse output, detect tool_call
│   │   │   │   ├── cursor.ts
│   │   │   │   ├── gemini.ts
│   │   │   │   └── hermes.ts
│   │   │   └── rocketchat/         ← reply poster (as bot)
│   │   └── package.json
│   │
│   └── mem0-api/                   ← Python FastAPI wrapper around Mem0
│       ├── app/main.py
│       ├── requirements.txt
│       └── Dockerfile
│
├── packages/                       ← shared TS libs
│   ├── schema/                     ← zod schemas, types
│   ├── db/                         ← drizzle / kysely for pg
│   └── rocketchat-client/          ← thin wrapper
│
├── db/
│   ├── migrations/                 ← SQL migration files
│   └── seed.sql
│
├── mcp-servers/                    ← tool definitions (optional, local)
│   ├── filesystem/
│   └── ...
│
└── docs/
    ├── ARCHITECTURE.md
    ├── DATA-MODEL.md
    ├── RUNBOOK.md
    └── ADR/
        ├── 001-chat-platform.md
        ├── 002-memory-engine.md
        └── ...
```

---

## 8. Docker & Deployment

### 8.1 `docker-compose.yml` — Dev Stack

```yaml
# Sketch — refined during Phase 0
services:
  mongo:
    image: mongo:7
    restart: unless-stopped
    volumes: [mongo-data:/data/db]
    command: --oplogSize=128 --replSet=rs0
    ports: ["27017:27017"]
    healthcheck:
      test: echo 'db.stats().ok' | mongosh localhost:27017/local --quiet
      interval: 10s

  rocketchat:
    image: rocketchat/rocket.chat:latest
    restart: unless-stopped
    depends_on: [mongo]
    ports: ["3000:3000"]
    environment:
      ROOT_URL: http://localhost:3000
      MONGO_URL: mongodb://mongo:27017/rocketchat?replicaSet=rs0
      MONGO_OPLOG_URL: mongodb://mongo:27017/local?replicaSet=rs0

  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: nexus
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-nexus_dev_pass}
      POSTGRES_DB: nexus
    ports: ["5433:5432"]                    # host 5433 → container 5432
    volumes: [pg-data:/var/lib/postgresql/data]

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports: ["6380:6379"]                    # host 6380 → container 6379
    volumes: [redis-data:/data]

  mem0-api:
    build: ./services/mem0-api
    restart: unless-stopped
    depends_on: [postgres]
    ports: ["4100:4100"]
    environment:
      POSTGRES_URL: postgresql://nexus:${POSTGRES_PASSWORD:-nexus_dev_pass}@postgres:5432/nexus

volumes:
  mongo-data:
  pg-data:
  redis-data:
```

**Services that run on the HOST (not Docker) during dev**:
- `nexus-gateway` → `cd services/gateway && bun run dev`
- `nexus-composer` → `cd services/composer && bun run dev`
- `nexus-runtime` → `cd services/runtime && bun run dev`

**Why**: all three are edited frequently and need instant hot-reload, and
the runtime needs access to `claude-code`, `cursor-agent`, `gemini`, and
`hermes` binaries on the host.

### 8.2 Bridging Host ↔ Container

Host services reach containers via `localhost:<port>` (every container
port is exposed). Containers do not need to reach back to host services
(traffic is one-way: host consumes container).

### 8.2.1 Port Allocation — Verified Clean (2026-04-21)

Ports allocated for N.E.X.U.S, chosen to avoid clashing with common host
services (e.g. a local Postgres on 5432, a local Redis on 6379):

| Service | Host port | Container port | Notes |
|---|---|---|---|
| Rocket.Chat | **3000** | 3000 | main UI |
| MongoDB | **27017** | 27017 | internal to Rocket.Chat |
| Postgres + pgvector | **5433** | 5432 | **5433 on host** to avoid clashing with a local Postgres install |
| Redis | **6380** | 6379 | **6380 on host** for the same reason |
| nexus-gateway | **4000** | — | host process (Bun) |
| nexus-composer | **4001** | — | host process (Bun) |
| nexus-runtime | **4002** | — | host process (Bun) |
| mem0-api | **4100** | 4100 | Python service in container |

Note: Postgres and Redis use non-default ports **on the host** (5433/6380)
as a best practice when other tools may need the default 5432/6379. The
container internals stay default (5432/6379). All env vars are
centralized in `.env`.

### 8.3 Workspace Path

The agent needs a working directory to execute tools (read/write files,
bash). It is controlled by an env var in `.env`:

```bash
NEXUS_WORKSPACE_ROOT=/path/to/your/coding-root
```

In dev = an absolute path to the folder containing the projects an agent
will be mounted onto. In prod = mounted to the appropriate path on the
server. Composer always resolves the project path via
`${NEXUS_WORKSPACE_ROOT}/<project.slug>` — the `projects.workspace_path`
column stores only the relative slug, not an absolute path (so it stays
portable across environments).

### 8.4 Future: Production (out of scope for v1, sketch only)

- Every service shipped as a Docker image.
- `nexus-runtime` bundled with the CLI agents via a multi-stage
  Dockerfile (install claude-code binary, etc.).
- Deploy on Kubernetes or Docker Swarm; managed Postgres.

---

## 9. Implementation Milestones

Each milestone has **acceptance criteria** that can be checked.

### **Phase 0 — Foundation** (est. 1-2 days)

**Goal**: infra stack running, can log in to Rocket.Chat.

- [ ] Repo init: `bun init`, `package.json` workspaces.
- [ ] `docker-compose.yml` with 4 services (mongo, rocketchat, postgres,
  redis).
- [ ] `.env.example` + `Makefile`.
- [ ] Initial Postgres migration (users, agents, rooms, messages
  skeleton).
- [ ] Create one admin user in Rocket.Chat, one test room.
- [ ] Create the `@claude` bot user in Rocket.Chat via the admin API.

**Acceptance**: `make up` → open `http://localhost:3000` → log in →
chatting in the test room works.

### **Phase 1 — Gateway Ingest & Echo Bot** (est. 2-3 days)

**Goal**: gateway captures every message; composer + runtime echo a reply
in the room.

- [ ] `nexus-gateway`: subscribe to DDP, ingest into Redis + Postgres.
- [ ] `nexus-composer`: stub — only echoes `"You said: ..."`.
- [ ] `nexus-runtime`: post the reply to Rocket.Chat as the bot user.
- [ ] Mention `@claude` → bot replies with the echo.
- [ ] Structured logging (pino) across every service.

**Acceptance**: typing `@claude hello` → the bot replies `You said: hello`
in under 2 seconds.

### **Phase 2 — Real CLI Invoke (Claude + Hermes)** (est. 3-4 days)

**Goal**: mentioning a bot calls the real CLI (`claude`, `hermes`) and
streams the response.

- [ ] `runtime/adapters/claude.ts`: spawn PTY, write prompt, read stdout.
- [ ] `runtime/adapters/hermes.ts`: same pattern, adjusted to Hermes' I/O
  format.
- [ ] Streamed posting: batched chunks (every 500ms or per newline) so
  the channel doesn't flood.
- [ ] Adapter pattern clean enough that Phase 5 only needs to add new
  adapters.
- [ ] Error handling: PTY crash, timeout (>60s default), kill signals.

**Acceptance**: `@claude explain a recursive Fibonacci function` → real
response from the Claude CLI. Same for `@hermes` to validate the Hermes
adapter.

### **Phase 3 — Mem0 Memory Layer + Attribution** (est. 4-5 days)

**Goal**: the bot remembers context across messages with clear
attribution.

- [ ] `mem0-api` service: FastAPI wrapper with add/search endpoints.
- [ ] Composer: hook Mem0 for `add` (every ingest) and `search` (every
  invoke).
- [ ] Attribution header builder (§5.3).
- [ ] Working memory: Redis rolling buffer of 50 messages per room.
- [ ] Scoping rules (§5.2) hard-enforced in the composer.

**Acceptance**:
- User A writes "I prefer ES modules" → several messages later, mention
  the bot → the bot knows A's preference.
- User A vents about a bug in DM → in a public room, the bot does not
  spill the contents of A's DM.

### **Phase 4 — Compaction Engine** (est. 3-4 days)

**Goal**: long chats don't blow up the context.

- [ ] Token counter (tiktoken / per-model approximation).
- [ ] Landmark detector (heuristics + optional LLM classifier).
- [ ] Summarizer (call an LLM via the Claude API or a non-interactive
  agent CLI).
- [ ] Cron worker: summarize per-tier (thread / session / day).
- [ ] At compose time: replace old raw with summary + landmarks.

**Acceptance**: simulate a room with 500 messages → the context handed to
the agent stays ≤ 70% of budget, but recall of older facts remains
accurate (manual test: 5 cases).

### **Phase 5 — Multi-Agent Expansion** (est. 2-3 days)

**Goal**: a single room can host multiple bots. Add `cursor-agent` +
`gemini` to the lineup (v1 already ships `claude` + `hermes` from
Phase 2).

- [ ] New adapters: `cursor-agent`, `gemini`.
- [ ] Bot provisioning: script to register a new bot user in
  Rocket.Chat.
- [ ] Per-agent configuration (model params, system prompt) in the
  `agents` table.

**Acceptance**: a room can invoke `@claude`, `@hermes`, `@cursor`, and
`@gemini` in sequential turns; all reply without conflict; memory is
properly partitioned (per-agent scope in Mem0).

### **Phase 6 — MCP Tool Registry** (est. 4-5 days)

**Goal**: agents can use external tools (filesystem, git, shell).

- [ ] Register MCP servers in the DB.
- [ ] Composer injects the tool list into the prompt per the room ACL.
- [ ] Runtime intercepts tool_call (per adapter) and forwards it to MCP.
- [ ] UIKit button for approving risky tools (exec, write).

**Acceptance**: `@claude list files in project saga-ai` → MCP filesystem
`list_directory` is called and the result appears in the reply.

### **Phase 7 — DM + ACL Hardening** (est. 2-3 days)

**Goal**: rock-solid privacy boundaries.

- [ ] Robust DM detection (edges: group DM, channel converted to DM).
- [ ] Permission check on every tool call (does the triggering user have
  the right?).
- [ ] Audit log table for every invoke + tool exec.
- [ ] Tests: attempt exploits (user B asks the bot to leak user A's DM).

**Acceptance**: privacy test suite (at least 10 cases) passes.

### **Phase 8 — Skill Registry** (est. 3-4 days, optional)

**Goal**: skills reusable across agents, inspired by OpenSpace.

- [ ] Skill schema (name, description, prompt template, tool deps).
- [ ] Simple CRUD UI (or DB seeds first).
- [ ] Composer: match user intent → inject the skill into the prompt.

**Acceptance**: a "code-review" skill can be invoked via
`/skill code-review <file>` in a room and the agent runs it per the
template.

### **Phase 9 — UI Polish** (est. 2-3 days)

**Goal**: nicer UX.

- [ ] Approval buttons for risky tools (UIKit).
- [ ] Diff viewer for file edits (rendered diff inline in messages).
- [ ] Command palette `/nexus ...` (status, attach-project, set-model).
- [ ] Simple health dashboard (room count, memory size, job queue).

**Acceptance**: common flows (mention, tool approval, diff review)
require no leaving Rocket.Chat.

---

## 10. Open Questions & Risks

### 10.1 Open Questions

| # | Question | Impact | When to decide |
|---|---|---|---|
| Q1 | PTY ephemeral (spawn per invoke) vs long-running? | Latency vs state complexity | End of Phase 2, after benchmarking |
| Q2 | Streaming to chat: edit-in-place a single message vs multiple messages? | Chat UX; edit floods Mongo | Phase 1, observe Rocket.Chat behavior |
| Q3 | Who pays for Claude/Gemini tokens? Per-user API key vs shared pool? | Cost tracking | Phase 2 |
| Q4 | If two users mention a bot in the same room concurrently, serialize or run in parallel? | Memory race conditions | Phase 3 |
| Q5 | Auto-detect project from messages (NER) vs manual tagging? | UX vs complexity | Phase 4 |
| Q6 | Should the bot be allowed to mention users back? (Notifications) | Annoying vs useful | Phase 1 |

### 10.2 Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Rocket.Chat upgrade breaks the DDP API | Pin a version in docker-compose; subscribe to the changelog |
| R2 | Mem0 extraction is slow → invoke delay | Async ingest (queued), bounded-timeout fallback for recall |
| R3 | CLI agent output parsing is fragile (each CLI emits a different tool_call format) | Adapter layer + integration test per CLI |
| R4 | Memory leak from a conversation that never compacts (trigger bug) | Hard cap on DB row count per room + alert |
| R5 | A tool exec performs a destructive action without approval | Default deny for `write` / `exec`, per-tool gate, audit log |
| R6 | Dev on host but prod in container → "works on my machine" | Phase 10: dockerize the runtime + CI test for container parity |
| R7 | Multiple agents replying simultaneously corrupts the threading logic | Per-room mutex on invoke (Redis lock) |

---

## 11. Immediate Next Steps

Phase 0 scaffolding (completed per the 2026-04-21 checkpoint):

1. **Repo scaffold**:
   - `package.json` workspaces + `bunfig.toml`
   - `docker-compose.yml` final for Phase 0
   - `services/gateway`, `services/composer`, `services/runtime`,
     `services/mem0-api` skeletons
   - `db/migrations/0001_init.sql` from §5.1
   - `Makefile` + `.env.example`
   - `README.md` with quick start

2. **Verify `make up` works** on the host machine.

3. **Phase 1** (Gateway Ingest + Echo Bot) — done.

4. **Per-milestone sign-off** continues for the remaining phases.

### Checkpoint — Approved 2026-04-21

- [x] **Codename**: **N.E.X.U.S** = *Networked Ensemble for eXtensible
  User-agent Sessions*
- [x] **Port allocation**: verified clean, final mapping in §8.2.1.
  Postgres host:5433, Redis host:6380, the rest are defaults.
- [x] **Workspace**: env var `NEXUS_WORKSPACE_ROOT` (must be an absolute
  path in `.env`); fail-fast if missing.
- [x] **CLI v1**: `claude` + `hermes`. `cursor-agent` + `gemini` arrive
  in Phase 5 (binary on host PATH or override via env var).
- [x] **License**: MIT, © Rahmat Kurnia.

All checkpoints approved. Ready to scaffold Phase 0.

---

*This document is living — every new ADR / decision is appended. Major
changes are versioned (v0.2, v0.3, ...).*
