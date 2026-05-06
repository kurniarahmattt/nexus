# N.E.X.U.S — Sharing Session Agents
## Dokumen Planning Lengkap

> **Status**: v0.2 — Checkpoint Approved, siap scaffold Phase 0
> **Tanggal**: 2026-04-21
> **Penanggung jawab**: Mas Rahmat (lead) + G.I.N.G (co-architect)
> **Codename**: **N.E.X.U.S** — **N**etworked **E**nsemble for e**X**tensible **U**ser-agent **S**essions
> **License**: Proprietary — © Rahmat Kurnia (interim, personal project)

---

## 0. Konteks & Tujuan

**Vision.** Membangun platform chat web-based yang memungkinkan **tim manusia berkolaborasi bersama AI Agent** dalam sebuah *room*. AI Agent bukan chatbot API biasa — ini adalah **wrapper atas AI CLI tools** (Claude Code, Cursor Agent, Gemini CLI, Hermes, Goose, OpenClaw, dll) yang punya akses eksekusi (filesystem, shell, tool calling).

**Use case inti**:
- Tim developer membuat room untuk suatu project.
- Satu atau beberapa bot AI Agent ditambahkan ke room sebagai "asisten tim".
- Anggota tim bisa berdiskusi antar-sesama manusia, mention bot untuk minta bantuan, atau nyimak diskusi user lain dengan bot.
- Tiap user juga bisa chat private (DM) dengan bot — bot wajib bisa membedakan konteks DM vs konteks room.
- Bot harus **ingat seluruh alur** (grup & DM), paham atribusi ("siapa bilang apa"), dan punya memory jangka pendek + jangka panjang dengan compaction otomatis saat context bloat.

**Problem yang diselesaikan**: saat ini tidak ada tool yang mempertemukan (a) multi-human team chat + (b) AI agent yang wrap CLI + (c) memory sophisticated + (d) skill/tool management. Tooling yang ada selalu kehilangan salah satu dari empat dimensi ini.

---

## 1. Ringkasan Keputusan Arsitektur (ADR Singkat)

| # | Keputusan | Alasan |
|---|---|---|
| ADR-001 | **Rocket.Chat** sebagai Chat UI | Apps-Engine paling matang untuk custom bot integration; REST+Realtime API lengkap; UIKit mendukung interactive button (untuk tool approval); Docker image resmi; MIT license. |
| ADR-002 | **Mem0** sebagai memory extraction & retrieval layer | State-of-the-art 2026 untuk agent memory; bisa self-host; agent-runtime-agnostic (penting karena kita swap CLI agents); user_id scoping built-in. |
| ADR-003 | **Postgres + pgvector** sebagai storage tunggal (structured + vector) | Konsolidasi service (satu DB untuk summary, facts, vector). Kurangi komponen dibanding Mem0+Qdrant+Postgres. pgvector sudah production-ready di 2026. |
| ADR-004 | **Redis** untuk working memory + job queue | Standar industri untuk ephemeral state + background job. |
| ADR-005 | **Bun + TypeScript** untuk layanan custom (Gateway, Composer, Runtime) | Performa tinggi, TypeScript native, startup cepat — cocok untuk service yang banyak I/O async. |
| ADR-006 | **Hybrid deploy di dev**: infra stateful di Docker, agent runtime di host | CLI tools (claude-code, cursor, hermes) ada di host. Containerize agent runtime di dev = kompleks (binary path, workspace mount, OS mismatch). Simpan itu untuk production. |
| ADR-007 | **MCP (Model Context Protocol)** untuk tool layer | Sudah standar; Claude Code native; mudah tambah tool baru tanpa ubah runtime. |
| ADR-008 | **Fresh memory isolation** | TIDAK menyentuh memory server / knowledge graph milik tooling lain di host. Nexus memory tersimpan di Postgres container milik Nexus sendiri. |
| ADR-009 | **Skill registry** — integrasi OpenSpace ditunda ke Phase 8 | Phase awal fokus ke memory + routing. Skill integration menambah kompleksitas yang belum perlu. |
| ADR-010 | **CLI agent v1 hanya `claude` + `hermes`** | Mas prefer start minimal. `cursor-agent` dan `gemini` akan ditambah di Phase 5 (Multi-Agent Expansion) setelah pola adapter stabil. |
| ADR-011 | **Workspace path via env var** (`NEXUS_WORKSPACE_ROOT`) | Wajib di-set absolute path di `.env`; tidak ada default fallback. Composer fail-fast kalau env kosong. |
| ADR-012 | **License interim: proprietary, © Rahmat Kurnia (personal)** | Repo personal Mas Rahmat. Keputusan license final (MIT/Apache vs tetap proprietary) ditunda sampai siap rilis publik. |

---

## 2. Scope v1 & Non-Goals

### In-Scope v1

- Web chat UI (via Rocket.Chat) dengan room, DM, thread, mention.
- Bot identity per-AI-agent (satu bot user per CLI, mis. `@claude`, `@cursor`, `@gemini`, `@hermes`).
- Message routing: @mention di room → invoke agent; DM ke bot → invoke agent private.
- Atribusi eksplisit: bot selalu tahu `{user, room, timestamp}` setiap pesan.
- Memory layers: working (Redis), episodic (Postgres summary), semantic (pgvector via Mem0), structured (Postgres tables).
- Scoped memory: per-room, per-DM, per-user-profile, per-project.
- Compaction: otomatis saat token budget ≥ 70% context window, dengan landmark preservation.
- CLI agent runtime pool v1: **`claude` + `hermes`** (adapter pattern siap untuk extend ke `cursor-agent`, `gemini`, dll di Phase 5).
- Tool layer: MCP server registry, per-room tool whitelist.
- ACL dasar: user tidak bisa akses DM user lain via bot; memory DM tidak leak ke room.
- Deploy: `docker compose up` di PC Mas.

### Non-Goals v1 (eksplisit dikeluarkan)

- Mobile native app (pakai Rocket.Chat mobile existing kalau butuh).
- Voice/video call.
- End-to-end encryption antar user (relying on Rocket.Chat default TLS).
- Multi-tenant SaaS (v1 single-tenant, tim Mas sendiri).
- Fine-grained billing / cost tracking per-user.
- Agent-to-agent orchestration otomatis (pakai ClawTeam existing kalau butuh orchestrasi agent paralel).
- Production hardening (backup, DR, HA) — akan jadi Phase 10+ saat move ke server.

---

## 3. Arsitektur Sistem

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
  │  MongoDB        │ ← internal ke Rocket.Chat, kita tidak akses langsung
  │  (Docker)       │
  └─────────────────┘
```

### 3.2 Penjelasan Per-Komponen

**Rocket.Chat** — UI & user management. Kita **tidak fork** Rocket.Chat. Kita consume via API. Setiap AI agent punya 1 bot user di Rocket.Chat (dibuat via admin API saat bootstrap).

**nexus-gateway** — entry point. Subscribe ke Rocket.Chat Realtime API (DDP via WebSocket), tangkap **semua** pesan (termasuk antar-user tanpa mention). Tugas utamanya:
1. *Ingest*: simpan pesan ke working memory Redis dengan atribusi lengkap.
2. *Detect invocation*: kalau pesan mention bot atau DM ke bot, push job ke queue.
3. *Backpressure*: rate-limit per-user per-room.

**nexus-composer** — otak sistem. Saat job invoke masuk:
1. Tarik working memory (N pesan terakhir) untuk `{room_id | dm_id}`.
2. Tarik user profile untuk semua participant aktif di window tersebut.
3. Tarik project memory bila room di-tag ke project.
4. Semantic search via Mem0 untuk "pernah bahas apa" yang relevan dengan pertanyaan terakhir.
5. Cek token budget. Jika > 70% → trigger compaction async untuk window yang akan dipakai (atau pakai summary kalau sudah ada).
6. Resolve tool list dari MCP registry + filter ACL per-room.
7. Compose final prompt dengan header atribusi yang eksplisit.
8. Kirim ke runtime.

**nexus-runtime** — spawner & PTY manager. **Wajib jalan di host**, bukan container, karena butuh akses binary CLI agents dan filesystem user. Pool management:
- Satu agent = satu long-running PTY process OR ephemeral per-turn (keputusan: **ephemeral v1**, lebih sederhana; long-running di v2 untuk latency).
- Stream stdout line-by-line → post ke Rocket.Chat sebagai bot user yang bersangkutan.
- Deteksi pola tool_call dari stdout (tiap CLI punya format sendiri — perlu adapter).

**Postgres + pgvector** — storage tunggal. Schema terpisah per concern (lihat §5.1).

**Redis** — (a) working memory rolling buffer, (b) job queue (BullMQ), (c) distributed lock saat dua invoke bersamaan di room yang sama.

**MCP servers** — tool providers. Standar MCP; jalan sebagai process terpisah di host. Registry di Postgres (tabel `mcp_servers` + `room_tool_acl`).

---

## 4. Tech Stack

### 4.1 Runtime & Bahasa

| Area | Pilihan | Versi target |
|---|---|---|
| Chat UI | Rocket.Chat | latest stable (6.x) |
| Mongo (untuk Rocket.Chat) | MongoDB | 7.x |
| Custom services | Bun + TypeScript | Bun ≥ 1.2 |
| DB utama | Postgres + pgvector | 16 + pgvector 0.7 |
| Ephemeral | Redis | 7-alpine |
| Memory layer | Mem0 (Python) | latest, run sebagai sidecar service |
| Job queue | BullMQ (di atas Redis) | latest |
| Tool protocol | MCP | latest spec |

### 4.2 Kenapa Bun bukan Node?

- Startup cepat (penting untuk CLI wrapper yang sering spawn).
- Native TypeScript execution tanpa build step.
- Built-in SQLite bisa dipakai untuk local dev cache.
- Compatible dengan npm package ecosystem.

### 4.3 Kenapa Mem0 jalan di Python bukan port ke TypeScript?

Mem0 upstream Python-only untuk fitur lengkapnya. Kita pakai sebagai **microservice** (Python/FastAPI) yang di-*dockerize*, custom services Bun consume via HTTP. Loose coupling.

### 4.4 Library list (indikatif)

**Gateway/Composer/Runtime (Bun)**:
- `@rocket.chat/sdk` atau `ddp-client` (realtime)
- `ioredis`, `bullmq`
- `pg` driver
- `zod` (schema validation)
- `pino` (logging)
- `hono` (HTTP endpoint internal)
- `node-pty` (PTY untuk CLI spawn)

**Mem0 service (Python)**:
- `mem0ai`
- `fastapi`, `uvicorn`
- `psycopg[binary]`

---

## 5. Data Model & Memory Design

### 5.1 Postgres Schema (sketsa)

```sql
-- Identitas & scoping
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
  workspace_path TEXT  -- path di host untuk agent workspace
);

-- Working memory (short buffer, rolling) — sebenarnya di Redis,
-- tabel ini untuk archival audit trail
CREATE TABLE messages (
  id            BIGSERIAL PRIMARY KEY,
  rocketchat_mid TEXT UNIQUE NOT NULL,
  room_id       UUID REFERENCES rooms(id),
  sender_user_id UUID REFERENCES users(id),
  sender_agent_id UUID REFERENCES agents(id),  -- NULL kalau dari user
  text          TEXT,
  metadata      JSONB,                         -- attachments, thread parent, reactions
  ts            TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON messages (room_id, ts DESC);

-- Episodic: summary hierarkis
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

-- Landmark: pesan yang tidak pernah di-compact (keputusan, spec, kode penting)
CREATE TABLE landmarks (
  id          BIGSERIAL PRIMARY KEY,
  message_id  BIGINT REFERENCES messages(id),
  kind        TEXT,            -- 'decision','spec','code','link'
  reason      TEXT,
  pinned_at   TIMESTAMPTZ DEFAULT now()
);

-- Fakta terstruktur (per-user, per-project)
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
  room_id     UUID REFERENCES rooms(id),
  mcp_server_id UUID REFERENCES mcp_servers(id),
  allowed_tools TEXT[],     -- subset, atau NULL = semua
  PRIMARY KEY (room_id, mcp_server_id)
);
```

### 5.2 Namespacing Memory (Mem0)

Mem0 natively punya `user_id`, `agent_id`, `run_id`, dan `metadata`. Kita pakai konvensi:

| Scope | user_id | agent_id | run_id | metadata.visibility |
|---|---|---|---|---|
| Pesan di room | `<user_uuid>` | `<agent_slug>` | `room:<room_uuid>` | `public` |
| Pesan di DM | `<user_uuid>` | `<agent_slug>` | `dm:<user_uuid>:<agent_slug>` | `private` |
| User profile | `<user_uuid>` | `<agent_slug>` | `profile:<user_uuid>` | `shared` |
| Project context | `*` (broadcast) | `<agent_slug>` | `project:<project_uuid>` | `shared` |

**Retrieval rule saat agent merespons di room X**:
```
filter = run_id IN ('room:<X>', 'profile:<participant_1>', ..., 'project:<Y>')
       AND visibility IN ('public','shared')
```

**Retrieval rule saat agent merespons di DM dengan user U**:
```
filter = run_id IN ('dm:<U>:<agent>', 'profile:<U>', 'project:<Y>')
       AND (visibility = 'private' AND user_id = <U>)
         OR visibility = 'shared'
```

ACL **hard-enforced di composer**, bukan mengandalkan prompt ke agent.

### 5.3 Attribution Format (prompt injection)

Setiap transcript yang masuk ke agent selalu punya header:

```
[SESSION CONTEXT]
Room: #auth-team (project: saga-ai)
Participants: Andi (backend lead), Budi (frontend), G.I.N.G
You are: @claude (Claude Code CLI agent)
Time: 2026-04-21 14:02 Asia/Jakarta

[RECALL — from long-term memory]
- Andi pernah bilang prefer JWT 30min expiry (fact, 2026-04-15, DM)
- Project saga-ai pakai NestJS + Prisma (project memory)

[LANDMARKS — pinned decisions]
- [2026-04-10] Team sepakat pakai refresh token rotation (by Budi)

[EPISODIC SUMMARY — last session]
Kemarin Andi & Budi bahas bug race condition di auth middleware,
Andi investigasi, belum resolve.

[RAW TRANSCRIPT — most recent 40 messages]
[14:02 | Andi] @claude kenapa token expiry cuma 15 menit?
[14:02 | Budi] aku usul 30 menit
[14:03 | Andi] iya, user komplain

[CURRENT INVOCATION]
Respond to Andi and Budi in room #auth-team.
```

Format ini eksplisit, deterministic, dan agent CLI bisa mencerna tanpa trik prompt-engineering berbelit.

### 5.4 Compaction Engine

**Trigger**: token estimate window > 70% context budget agent.

**Algoritma**:
1. Identifikasi window yang akan di-compact (biasanya pesan tertua yang belum punya summary).
2. Deteksi **landmarks** dalam window (heuristik: mengandung "decision:", "spec:", code block ≥ 20 baris, @mention plus verb imperatif, link ke spec). Auto-pin ke tabel `landmarks`.
3. Pisahkan pesan landmark dari pesan biasa.
4. Kirim non-landmark ke LLM summarizer (prompt: "Extract facts, decisions, action items, unresolved questions. Preserve speaker attribution.").
5. Simpan hasil ke `summaries` tabel dengan embedding.
6. Saat compose berikutnya: ganti window lama dengan `summary + landmarks full text`.

**Tier cascade**:
- Message → Thread summary (saat thread close atau > 50 msg)
- Thread → Session summary (setiap ~1 jam inaktif)
- Session → Day summary (nightly job)
- Day → Week summary (weekly job)

Semakin lama, resolusi semakin kasar. Selalu ada **fallback vector search** kalau user minta detail lama ("tolong recall diskusi tanggal sekian").

---

## 6. Alur Utama (Flows)

### 6.1 Flow A — User Chat Antar User (tanpa bot mention)

```
User A kirim pesan di #auth-team
  └─► Rocket.Chat broadcast ke peer + DDP event
        └─► nexus-gateway terima event
              └─► ingest: simpan ke Redis working buffer + Postgres messages
              └─► BUKAN invoke trigger (tidak ada mention)
```
Working memory terupdate; bot "menyimak" tanpa merespons.

### 6.2 Flow B — User Mention Bot di Room

```
User A: "@claude tolong cek bug auth.ts"
  └─► gateway detect mention @claude
        └─► ingest message ke working memory
        └─► publish job 'invoke' ke Redis queue
              {agent: 'claude-code', room_id, trigger_msg_id}
  └─► composer pickup job
        ├─► fetch working memory (last 40 msg)
        ├─► fetch profiles dari user aktif (A, + lainnya)
        ├─► semantic recall via Mem0 (query: pesan terakhir)
        ├─► fetch project memory
        ├─► token estimate → kalau > 70%, trigger compaction inline (sync)
        ├─► resolve MCP tools allowed di room
        ├─► build prompt dengan attribution header
        └─► publish 'execute' ke runtime
  └─► runtime spawn claude-code PTY dengan prompt
        ├─► stream stdout tiap chunk:
        │     ├─► post ke Rocket.Chat sebagai @claude (via REST API)
        │     └─► ingest reply juga ke working memory + Mem0
        ├─► detect tool_call pattern
        │     ├─► minta approval (UIKit button) kalau tool di-gate
        │     └─► eksekusi via MCP server, stdout hasil back ke PTY stdin
        └─► PTY exit → final flush
```

### 6.3 Flow C — User DM ke Bot

```
User A buka DM dengan @claude, kirim pesan
  └─► gateway detect: room.kind = 'dm' AND counterparty = agent
        └─► invoke, run_id = 'dm:A:claude-code'
  └─► composer: scope sempit (DM memory + A's profile + project if tagged)
  └─► runtime: spawn dan reply di DM channel
```
Memory DM terisolasi, **tidak bocor** ke room public.

### 6.4 Flow D — Compaction Scheduled

```
Cron job tiap 1 jam:
  └─► scan rooms yang aktif dalam 1 jam terakhir
  └─► untuk tiap room, kalau ada window belum ter-summary:
        ├─► extract landmarks
        ├─► summarize non-landmark
        └─► store summary + embedding
```

### 6.5 Flow E — Tambah Bot ke Room Baru

```
Admin bikin room di Rocket.Chat, invite @claude
  └─► gateway detect 'ru' (room update) event
        └─► upsert rooms tabel
        └─► default ACL: project memory = NULL sampai di-tag
        └─► default tool: basic subset (file read only, no exec)
  └─► admin run slash command /nexus attach-project saga-ai
        └─► set rooms.project_id + tool ACL expanded
```

---

## 7. Struktur Repo

```
nexus/
├── README.md
├── PLANNING.md                     ← dokumen ini
├── docker-compose.yml              ← stack development
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
│   │   └── Dockerfile              ← optional, dev pakai host
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
│   └── mem0-api/                   ← Python FastAPI wrapper atas Mem0
│       ├── app/main.py
│       ├── requirements.txt
│       └── Dockerfile
│
├── packages/                       ← shared TS libs
│   ├── schema/                     ← zod schemas, types
│   ├── db/                         ← drizzle / kysely untuk pg
│   └── rocketchat-client/          ← thin wrapper
│
├── db/
│   ├── migrations/                 ← SQL migration files
│   └── seed.sql
│
├── mcp-servers/                    ← tool definitions (optional local)
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
# Sketsa — akan di-refine saat Phase 0
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

**Services yang jalan di HOST (bukan Docker) saat dev**:
- `nexus-gateway` → `cd services/gateway && bun run dev`
- `nexus-composer` → `cd services/composer && bun run dev`
- `nexus-runtime` → `cd services/runtime && bun run dev`

**Alasan**: ketiganya sering di-edit, hot reload harus instan, dan runtime butuh akses `claude-code`, `cursor-agent`, `gemini`, `hermes` yang ada di host.

### 8.2 Bridging Host ↔ Container

Service host connect ke container via `localhost:<port>` (semua port container di-expose). Sebaliknya, container tidak butuh reach ke host layanan (arus data satu arah: host consume container).

### 8.2.1 Port Allocation — Verified Clean (2026-04-21)

Port yang dialokasikan untuk N.E.X.U.S, sudah dicek tidak bentrok dengan service existing di PC Mas (benchmach-ui pakai 3003, benchmach stack pakai 7789/8082/8030/8025):

| Service | Host port | Container port | Keterangan |
|---|---|---|---|
| Rocket.Chat | **3000** | 3000 | UI utama |
| MongoDB | **27017** | 27017 | internal Rocket.Chat |
| Postgres + pgvector | **5433** | 5432 | **5433 di host** untuk menghindari konflik potensial saat Mas pasang pg lokal lain di masa depan |
| Redis | **6380** | 6379 | **6380 di host**, alasan serupa |
| nexus-gateway | **4000** | — | host process (Bun) |
| nexus-composer | **4001** | — | host process (Bun) |
| nexus-runtime | **4002** | — | host process (Bun) |
| mem0-api | **4100** | 4100 | Python service di container |

Catatan: Postgres dan Redis pakai port non-default **di host** (5433/6380) sebagai best-practice saat ada kemungkinan tool lain butuh 5432/6379 default. Container internal tetap default (5432/6379). Semua env var di-centralize di `.env`.

### 8.3 Workspace Path

Agent butuh working directory untuk eksekusi tool (read/write file, bash). Dikontrol via env var di `.env`:

```bash
NEXUS_WORKSPACE_ROOT=/path/to/your/coding-root
```

Di dev = absolute path ke folder berisi project-project yang akan di-mount agent. Di prod = akan di-mount ke path sesuai server. Composer selalu resolve path project via `${NEXUS_WORKSPACE_ROOT}/<project.slug>` — tabel `projects.workspace_path` hanya store slug relatif, bukan absolute path (supaya portable lintas environment).

### 8.3 Future: Production (di luar scope v1, sketsa saja)

- Semua service jadi image Docker.
- `nexus-runtime` di-bundle dengan CLI agents via multi-stage Dockerfile (install claude-code binary, dll).
- Deploy di K8s atau Docker Swarm; Postgres managed.

---

## 9. Milestone Implementasi

Tiap milestone punya **acceptance criteria** yang bisa dicek.

### **Phase 0 — Foundation** (est. 1-2 hari)

**Target**: stack infra jalan, bisa login ke Rocket.Chat.

- [ ] Repo init: `bun init`, `package.json` workspaces.
- [ ] `docker-compose.yml` dengan 4 service (mongo, rocketchat, postgres, redis).
- [ ] `.env.example` + `Makefile`.
- [ ] Migrasi Postgres awal (users, agents, rooms, messages skeleton).
- [ ] Buat 1 admin user di Rocket.Chat, 1 room test.
- [ ] Buat bot user `@claude` di Rocket.Chat via admin API.

**Acceptance**: `make up` → buka `http://localhost:3000` → login → chat di room test bisa.

### **Phase 1 — Gateway Ingest & Echo Bot** (est. 2-3 hari)

**Target**: gateway capture semua pesan, composer+runtime echo balik di room.

- [ ] `nexus-gateway`: subscribe DDP, ingest ke Redis+Postgres.
- [ ] `nexus-composer`: stub — hanya echo `"You said: ..."`.
- [ ] `nexus-runtime`: post reply ke Rocket.Chat sebagai bot.
- [ ] Mention `@claude` → bot reply echo.
- [ ] Logging terstruktur (pino) di semua service.

**Acceptance**: ketik `@claude hello` → bot balas `You said: hello` dalam < 2 detik.

### **Phase 2 — Real CLI Invoke (Claude + Hermes)** (est. 3-4 hari)

**Target**: mention bot → panggil CLI beneran (`claude`, `hermes`), stream jawabannya.

- [ ] `runtime/adapters/claude.ts`: spawn PTY, write prompt, read stdout.
- [ ] `runtime/adapters/hermes.ts`: sama pattern, sesuaikan format I/O Hermes.
- [ ] Streaming post: batched chunks (tiap 500ms atau newline) supaya chat tidak flood.
- [ ] Adapter pattern rapi supaya Phase 5 tinggal tambah adapter baru.
- [ ] Handle error: PTY crash, timeout (>60 detik default), kill signal.

**Acceptance**: `@claude jelaskan fungsi fibonacci rekursif` → balas hasil beneran dari Claude CLI. Idem `@hermes` untuk test Hermes adapter.

### **Phase 3 — Mem0 Memory Layer + Attribution** (est. 4-5 hari)

**Target**: bot ingat konteks lintas-pesan, atribusi jelas.

- [ ] `mem0-api` service: FastAPI wrapper dengan endpoint add/search.
- [ ] Composer: hook Mem0 untuk `add` (tiap ingest) dan `search` (saat invoke).
- [ ] Attribution header builder (§5.3).
- [ ] Working memory: Redis rolling buffer 50 pesan per room.
- [ ] Scoping rules (§5.2) di-enforce di composer.

**Acceptance**:
- User A tulis "aku prefer ES modules" → beberapa pesan kemudian mention bot → bot tahu preferensi A.
- User A di DM curhat soal bug → di room public, bot tidak spill isi DM A.

### **Phase 4 — Compaction Engine** (est. 3-4 hari)

**Target**: chat panjang tidak meledakkan context.

- [ ] Token counter (tiktoken / pendekatan per-model).
- [ ] Landmark detector (heuristik + optional LLM classifier).
- [ ] Summarizer (panggil LLM via Claude API atau agent CLI non-interactive).
- [ ] Cron worker: summarize per-tier (thread/session/day).
- [ ] Compose time: ganti raw lama dengan summary + landmarks.

**Acceptance**: simulasi room dengan 500 pesan → context yang masuk ke agent ≤ 70% budget, tapi recall fakta lama masih akurat (manual test 5 kasus).

### **Phase 5 — Multi-Agent Expansion** (est. 2-3 hari)

**Target**: 1 room bisa punya beberapa bot. Tambah `cursor-agent` + `gemini` ke lineup (v1 sudah punya `claude` + `hermes` dari Phase 2).

- [ ] Adapter baru: `cursor-agent`, `gemini`.
- [ ] Bot provisioning: script untuk register bot user baru di Rocket.Chat.
- [ ] Per-agent config (model params, system prompt) di tabel `agents`.

**Acceptance**: room bisa panggil `@claude`, `@hermes`, `@cursor`, `@gemini` di turn berurutan, semua reply tanpa konflik, memory terbagi proper (per-agent scope di Mem0).

### **Phase 6 — MCP Tool Registry** (est. 4-5 hari)

**Target**: agent bisa pakai tool eksternal (filesystem, git, shell).

- [ ] Registrasi MCP server di DB.
- [ ] Composer injeksi tool list ke prompt sesuai ACL room.
- [ ] Runtime intercept tool_call (sesuai adapter), forward ke MCP.
- [ ] UIKit button untuk approval tool berisiko (exec, write).

**Acceptance**: `@claude list files di project saga-ai` → tool `list_directory` MCP filesystem dipanggil, hasil masuk ke balasan.

### **Phase 7 — DM + ACL Hardening** (est. 2-3 hari)

**Target**: privacy boundary solid.

- [ ] DM detection robust (edge: group DM, channel converted to DM).
- [ ] Permission check setiap tool call (user yang trigger punya hak?).
- [ ] Audit log tabel untuk setiap invoke + tool exec.
- [ ] Test: coba eksploitasi (user B minta bot bocorin DM user A).

**Acceptance**: test suite privacy (minimal 10 kasus) lolos.

### **Phase 8 — Skill Registry** (est. 3-4 hari, opsional)

**Target**: skill reusable lintas-agent, inspired by OpenSpace.

- [ ] Skill schema (nama, deskripsi, prompt template, tool deps).
- [ ] CRUD UI sederhana (atau via DB seed dulu).
- [ ] Composer: match user intent → inject skill ke prompt.

**Acceptance**: skill "code-review" bisa dipanggil `/skill code-review <file>` di room, agent menjalankan sesuai template.

### **Phase 9 — UI Polish** (est. 2-3 hari)

**Target**: UX lebih enak.

- [ ] Approval button untuk tool berisiko (UIKit).
- [ ] Diff viewer untuk edit file (render diff di pesan).
- [ ] Command palette `/nexus ...` (status, attach-project, set-model).
- [ ] Health dashboard sederhana (room count, mem size, job queue).

**Acceptance**: flow umum (mention, tool approve, diff review) tidak butuh keluar dari Rocket.Chat.

---

## 10. Open Questions & Risks

### 10.1 Open Questions

| # | Pertanyaan | Dampak | Kapan decide |
|---|---|---|---|
| Q1 | PTY ephemeral (spawn per-invoke) vs long-running? | Latency vs kompleksitas state | Phase 2 end, benchmark |
| Q2 | Streaming ke chat: update pesan in-place (edit) vs multiple messages? | UX chat; edit flood MongoDB | Phase 1, lihat perilaku Rocket.Chat |
| Q3 | Siapa yang bayar token Claude/Gemini? per-user API key atau shared pool? | Cost tracking | Phase 2 |
| Q4 | Kalau 2 user mention bot bersamaan di room sama, serialize atau parallel? | Race condition memory | Phase 3 |
| Q5 | Auto-detect proyek dari pesan (NER) vs tagging manual? | UX vs kompleksitas | Phase 4 |
| Q6 | Apakah bot perlu bisa mention user balik? (notif) | Annoying vs useful | Phase 1 |

### 10.2 Risks

| # | Risiko | Mitigasi |
|---|---|---|
| R1 | Rocket.Chat upgrade breaking DDP API | Pin versi di docker-compose; subscribe ke changelog |
| R2 | Mem0 extraction lambat → invoke delay | Async ingest (di-queue), fetch recall dengan timeout fallback |
| R3 | CLI agent output parsing rapuh (tiap CLI beda format tool_call) | Adapter layer + integration test per CLI |
| R4 | Memory leak dari conversation yang tidak pernah compact (bug trigger) | Hard cap di DB row count per room + alert |
| R5 | Tool exec melakukan operasi destruktif tanpa approval | Default deny untuk `write`/`exec`, per-tool gate + audit log |
| R6 | Dev di host tapi prod di container → "works on my machine" | Phase 10: dockerize runtime + CI test di container-parity |
| R7 | Multiple agents reply bersamaan merusak threading logic | Mutex per-room saat invoke (Redis lock) |

---

## 11. Langkah Selanjutnya (Immediate)

Setelah plan ini di-approve Mas Rahmat, urutan eksekusi:

1. **Aku scaffold repo**:
   - `package.json` workspaces + `bunfig.toml`
   - `docker-compose.yml` final untuk Phase 0
   - `services/gateway`, `services/composer`, `services/runtime`, `services/mem0-api` skeleton (file minimal bisa di-run)
   - `db/migrations/0001_init.sql` dari §5.1
   - `Makefile` + `.env.example`
   - `README.md` dengan quick start

2. **Mas Rahmat verifikasi `make up` jalan** di PC.

3. **Aku lanjut Phase 1** (Gateway Ingest + Echo Bot) sampai acceptance.

4. **Ngobrol lagi** per milestone untuk sign-off sebelum lanjut.

### Checkpoint — Approved 2026-04-21

- [x] **Codename**: **N.E.X.U.S** = *Networked Ensemble for eXtensible User-agent Sessions*
- [x] **Port allocation**: verified clean, final mapping di §8.2.1. Postgres host:5433, Redis host:6380, sisanya default.
- [x] **Workspace**: env var `NEXUS_WORKSPACE_ROOT` (wajib absolute path di `.env`); fail-fast kalau kosong.
- [x] **CLI v1**: `claude` + `hermes`. `cursor-agent` + `gemini` di Phase 5 (binary di PATH host atau override via env var).
- [x] **License**: proprietary, © Rahmat Kurnia (interim, personal project).

Semua checkpoint approved. Siap lanjut scaffold Phase 0.

---

*Dokumen ini living — setiap ADR / keputusan baru akan di-append. Perubahan major di-version (v0.2, v0.3, ...).*
