-- ============================================================================
-- Phase 6A — Remote agents (user-owned bridges).
-- Extend `agents` to support per-user sessions hosted on the user's PC via
-- a `nexus-bridge` WebSocket client. Slug convention: '<cli>-<username>'.
-- ============================================================================

-- kind: 'shared' = legacy claude/hermes/cursor/gemini, 'remote' = bridge.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'shared'
    CHECK (kind IN ('shared','remote'));

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS last_connected_at TIMESTAMPTZ;

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_agents_kind ON agents (kind);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents (owner_user_id);

-- Back-fill: existing rows stay 'shared' (default).

INSERT INTO schema_migrations (version) VALUES ('0005_remote_agents') ON CONFLICT DO NOTHING;
