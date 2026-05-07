-- ============================================================================
-- Phase 6B — Bridge join codes (one-shot, time-bounded credential exchange).
-- ============================================================================
-- A "join code" is the single artifact a host admin hands to a developer
-- to onboard their bridge. It carries:
--   • The agent slug (which bridge identity to assume)
--   • A short-lived, one-shot exchange token (THIS table)
--
-- The actual bridge_token + persona config live in agents.config and never
-- leave the server until the developer's CLI POSTs to /join/<code>. On
-- success, the code is marked consumed (SELECT FOR UPDATE) and can never
-- be reused. Expired codes are inert.
-- ============================================================================

CREATE TABLE IF NOT EXISTS bridge_join_codes (
  code           TEXT PRIMARY KEY,
  agent_slug     TEXT NOT NULL REFERENCES agents(slug) ON DELETE CASCADE,
  issued_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  consumed_at    TIMESTAMPTZ,
  consumed_from  TEXT      -- IP that claimed it; for audit
);

CREATE INDEX IF NOT EXISTS idx_bridge_join_codes_slug
  ON bridge_join_codes (agent_slug);

CREATE INDEX IF NOT EXISTS idx_bridge_join_codes_active
  ON bridge_join_codes (expires_at)
  WHERE consumed_at IS NULL;

INSERT INTO schema_migrations (version) VALUES ('0008_bridge_join_codes')
  ON CONFLICT DO NOTHING;
