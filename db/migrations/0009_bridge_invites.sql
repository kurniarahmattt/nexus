-- ============================================================================
-- Phase 6C — Bridge invites (admin-issued tokens for self-service bridge
-- creation by developers).
-- ============================================================================
-- An "invite" is the artifact a host admin hands to a teammate so the
-- teammate can spin up a NEW bridge for themselves without the admin
-- having to run `make create-bridge` for each one.
--
-- Difference from bridge_join_codes:
--   • join_codes  → claim an EXISTING bridge identity (admin already
--                    decided slug/persona/cwd).
--   • invites     → CREATE a new bridge (the dev picks role, cwd, CLI
--                    within constraints set by the admin).
--
-- The invite carries:
--   • who can use it (allowed_user_id) — typically the dev's user UUID,
--     or NULL for "any team member"
--   • what CLIs are allowed (allowed_cli_kinds) — admin can constrain
--     to ['claude'] only, or leave empty = all
--   • expiry, consumed_at — same one-shot semantics as join codes
-- ============================================================================

CREATE TABLE IF NOT EXISTS bridge_invites (
  code               TEXT PRIMARY KEY,
  issued_by          UUID REFERENCES users(id) ON DELETE SET NULL,
  -- If set, only this user can consume the invite. NULL = any user.
  allowed_user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  -- e.g. ARRAY['claude','cursor']. Empty array = no constraint.
  allowed_cli_kinds  TEXT[] NOT NULL DEFAULT '{}',
  -- Optional: namespace prefix. If set, all bridges created via this
  -- invite must have a slug starting with this prefix. NULL = no prefix.
  slug_prefix        TEXT,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  -- One-shot by default. Set max_uses > 1 to allow reuse (e.g. team
  -- onboarding link with 5 seats). Each consumption increments uses_count.
  max_uses           INT NOT NULL DEFAULT 1,
  uses_count         INT NOT NULL DEFAULT 0,
  -- For audit. Each consumption logs the resulting slug + IP separately
  -- in bridge_invite_uses below.
  notes              TEXT
);

CREATE TABLE IF NOT EXISTS bridge_invite_uses (
  id              BIGSERIAL PRIMARY KEY,
  invite_code     TEXT NOT NULL REFERENCES bridge_invites(code) ON DELETE CASCADE,
  consumed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_from   TEXT,
  resulting_slug  TEXT NOT NULL,
  consumed_by     UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_bridge_invites_active
  ON bridge_invites (expires_at)
  WHERE uses_count < max_uses;

CREATE INDEX IF NOT EXISTS idx_bridge_invite_uses_code
  ON bridge_invite_uses (invite_code);

INSERT INTO schema_migrations (version) VALUES ('0009_bridge_invites')
  ON CONFLICT DO NOTHING;
