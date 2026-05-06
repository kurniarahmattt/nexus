-- ============================================================================
-- N.E.X.U.S — Initial Schema
-- Ref: PLANNING.md §5.1
-- ============================================================================
-- Catatan: file ini di-mount ke /docker-entrypoint-initdb.d/ pada container
-- Postgres pertama kali start. Untuk migrasi incremental nanti (Phase 1+)
-- pakai db/migrate.sh.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================================
-- Identitas & Scoping
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rocketchat_id TEXT UNIQUE NOT NULL,
  username      TEXT NOT NULL,
  display_name  TEXT,
  email         TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (username);

CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug            TEXT UNIQUE NOT NULL,
  display_name    TEXT NOT NULL,
  description     TEXT,
  workspace_path  TEXT,  -- relatif terhadap NEXUS_WORKSPACE_ROOT
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug              TEXT UNIQUE NOT NULL,           -- 'claude', 'hermes', ...
  display_name      TEXT NOT NULL,
  cli_command       TEXT NOT NULL,                  -- binary name atau absolute path
  cli_args          JSONB NOT NULL DEFAULT '[]'::jsonb,
  rocketchat_bot_id TEXT UNIQUE,                    -- diisi saat bootstrap
  rocketchat_username TEXT UNIQUE NOT NULL,         -- 'claude', 'hermes'
  config            JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled           BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  rocketchat_rid TEXT UNIQUE NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('channel','private','dm')),
  name           TEXT,                              -- NULL untuk DM
  project_id     UUID REFERENCES projects(id) ON DELETE SET NULL,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rooms_project ON rooms (project_id);
CREATE INDEX IF NOT EXISTS idx_rooms_kind ON rooms (kind);

-- ============================================================================
-- Transcript (audit + replay)
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
  id               BIGSERIAL PRIMARY KEY,
  rocketchat_mid   TEXT UNIQUE NOT NULL,
  room_id          UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_user_id   UUID REFERENCES users(id)  ON DELETE SET NULL,
  sender_agent_id  UUID REFERENCES agents(id) ON DELETE SET NULL,
  thread_parent_mid TEXT,                           -- rocketchat parent mid kalau reply di thread
  text             TEXT,
  metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts               TIMESTAMPTZ NOT NULL,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_user_id IS NOT NULL OR sender_agent_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages (room_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_messages_sender_user ON messages (sender_user_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_agent ON messages (sender_agent_id);

-- ============================================================================
-- Episodic: hierarchical summaries
-- ============================================================================

CREATE TABLE IF NOT EXISTS summaries (
  id          BIGSERIAL PRIMARY KEY,
  room_id     UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  tier        TEXT NOT NULL CHECK (tier IN ('thread','session','day','week')),
  start_ts    TIMESTAMPTZ NOT NULL,
  end_ts      TIMESTAMPTZ NOT NULL,
  summary     TEXT NOT NULL,
  embedding   vector(1536),                         -- 1536 = OpenAI small / anthropic compatible sized via mem0
  message_count INTEGER NOT NULL DEFAULT 0,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_summaries_room_ts ON summaries (room_id, tier, end_ts DESC);
CREATE INDEX IF NOT EXISTS idx_summaries_embedding ON summaries USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================================
-- Landmarks: pinned messages, never compacted
-- ============================================================================

CREATE TABLE IF NOT EXISTS landmarks (
  id          BIGSERIAL PRIMARY KEY,
  message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  room_id     UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('decision','spec','code','link','question','action_item')),
  reason      TEXT,
  extracted_by TEXT,                                -- 'heuristic' atau 'llm'
  pinned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_landmarks_room ON landmarks (room_id, pinned_at DESC);

-- ============================================================================
-- Structured facts (per-user, per-project, per-room)
-- ============================================================================

CREATE TABLE IF NOT EXISTS facts (
  id                BIGSERIAL PRIMARY KEY,
  scope_kind        TEXT NOT NULL CHECK (scope_kind IN ('user','project','room','global')),
  scope_id          UUID,                           -- NULL kalau scope='global'
  key               TEXT NOT NULL,
  value             JSONB NOT NULL,
  source_message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  confidence        REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope_kind, scope_id, key)
);
CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts (scope_kind, scope_id);

-- ============================================================================
-- MCP tool registry + ACL
-- ============================================================================

CREATE TABLE IF NOT EXISTS mcp_servers (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug          TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  command       TEXT NOT NULL,
  args          JSONB NOT NULL DEFAULT '[]'::jsonb,
  env           JSONB NOT NULL DEFAULT '{}'::jsonb,
  description   TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS room_tool_acl (
  room_id        UUID REFERENCES rooms(id) ON DELETE CASCADE,
  mcp_server_id  UUID REFERENCES mcp_servers(id) ON DELETE CASCADE,
  allowed_tools  TEXT[],                            -- NULL = semua tool di server diizinkan
  require_approval TEXT[],                          -- list tool yang butuh approval UIKit
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, mcp_server_id)
);

-- ============================================================================
-- Audit log (Phase 7+)
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  event_type   TEXT NOT NULL,                       -- 'invoke','tool_call','tool_approve','compaction'...
  actor_user_id  UUID REFERENCES users(id)  ON DELETE SET NULL,
  actor_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  room_id      UUID REFERENCES rooms(id) ON DELETE SET NULL,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log (event_type, ts DESC);

-- ============================================================================
-- Schema version tracking (untuk migrasi inkremental nanti)
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_migrations (version) VALUES ('0001_init') ON CONFLICT DO NOTHING;

-- ============================================================================
-- updated_at trigger helper
-- ============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['users','projects','agents','rooms','facts'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_updated_at ON %I;', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t
    );
  END LOOP;
END $$;
