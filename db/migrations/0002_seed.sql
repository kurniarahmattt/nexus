-- ============================================================================
-- N.E.X.U.S — Seed Data
-- ============================================================================
-- Agents v1: claude + hermes
-- rocketchat_bot_id akan diisi oleh scripts/bootstrap-rocketchat.sh
-- ============================================================================

INSERT INTO agents (slug, display_name, cli_command, cli_args, rocketchat_username, config, enabled)
VALUES
  ('claude', 'Claude Code', 'claude', '[]'::jsonb,
   'claude',
   '{"description":"Anthropic Claude Code CLI agent","model":"claude-sonnet-4-6"}'::jsonb,
   true),
  ('hermes', 'Hermes Agent', 'hermes', '[]'::jsonb,
   'hermes',
   '{"description":"Nous Research Hermes autonomous agent","model":"hermes-3"}'::jsonb,
   true)
ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  cli_command  = EXCLUDED.cli_command,
  config       = EXCLUDED.config,
  updated_at   = now();

INSERT INTO schema_migrations (version) VALUES ('0002_seed') ON CONFLICT DO NOTHING;
