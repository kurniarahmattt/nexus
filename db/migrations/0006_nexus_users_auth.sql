-- ============================================================================
-- Phase 7 — Nexus-managed users (admin + user) with own auth tokens.
-- Extends existing users table; keeps RC-autocreated rows untouched by
-- defaulting role='user' and leaving nexus_created=false.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('admin','user'));
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_token TEXT UNIQUE;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS rocketchat_password TEXT;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS nexus_created BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role) WHERE role = 'admin';
CREATE INDEX IF NOT EXISTS idx_users_auth_token ON users (auth_token);

-- Seed a built-in admin if missing. Uses placeholder rocketchat_id that the
-- bootstrap step will replace with the real admin's _id.
INSERT INTO users (rocketchat_id, username, display_name, role, nexus_created)
VALUES ('admin-seed', 'admin', 'Nexus Admin', 'admin', true)
ON CONFLICT (rocketchat_id) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('0006_nexus_users_auth') ON CONFLICT DO NOTHING;
