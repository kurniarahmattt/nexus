-- ============================================================================
-- Phase 6C+ — bridge_invites: default channels.
-- ============================================================================
-- Lets the host admin pre-approve channels that any bridge created from
-- this invite will be auto-invited into. This keeps channel membership
-- admin-gated (security boundary) while still letting devs go from
-- "got an invite" to "bot is live in the team's channels" in one
-- command on their laptop.
--
-- Empty array = no auto-invitation (admin must run `make invite-bot`
-- after the dev's bridge is up). Populated array = gateway invites the
-- new bot to each channel during /invite/:code consumption.
-- ============================================================================

ALTER TABLE bridge_invites
  ADD COLUMN IF NOT EXISTS default_channels TEXT[] NOT NULL DEFAULT '{}';

INSERT INTO schema_migrations (version) VALUES ('0010_invite_default_channels')
  ON CONFLICT DO NOTHING;
