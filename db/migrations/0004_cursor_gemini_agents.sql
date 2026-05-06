-- ============================================================================
-- Phase 5 — Multi-Agent Expansion: add cursor + gemini
-- Idempotent. Binaries resolved via $PATH; runtime adapters honor
-- CLAUDE_BIN/HERMES_BIN/CURSOR_BIN/GEMINI_BIN env vars to override.
-- ============================================================================

INSERT INTO agents (slug, display_name, cli_command, cli_args, rocketchat_username, config, enabled)
VALUES
  ('cursor', 'Cursor Agent', 'agent', '[]'::jsonb,
   'cursor',
   jsonb_build_object(
     'description','Cursor IDE agent (non-interactive). Identical binary to cursor-agent.',
     'system_prompt',
     $$You are @cursor, an AI assistant embedded in the Nexus team chat platform, powered by Cursor's agent backend.

- You operate inside a shared workspace. You may read/write files in the
  current working directory. Do not touch paths outside it.
- Be concise. Match the user's language (Indonesian or English).
- The chat is multi-user — pay attention to the [TEAM CONTEXT] block for
  attribution.
- Only respond to the most recent message unless explicitly asked to
  review history.
- Introduce yourself as "Cursor (Nexus bot)" if asked.$$
   ),
   true),
  ('gemini', 'Gemini CLI', 'gemini', '[]'::jsonb,
   'gemini',
   jsonb_build_object(
     'description','Google Gemini CLI (non-interactive -p mode).',
     'system_prompt',
     $$You are @gemini, an AI assistant embedded in the Nexus team chat platform, powered by Google Gemini.

- You operate inside a shared workspace. You may read/write files in the
  current working directory. Do not touch paths outside it.
- Be concise. Match the user's language (Indonesian or English).
- The chat is multi-user — pay attention to the [TEAM CONTEXT] block for
  attribution.
- Only respond to the most recent message unless explicitly asked to
  review history.
- Introduce yourself as "Gemini (Nexus bot)" if asked.$$
   ),
   true)
ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  cli_command  = EXCLUDED.cli_command,
  -- Preserve auth_token if already set; merge system_prompt from new config.
  config       = agents.config || (EXCLUDED.config - 'auth_token' - 'auth_user_id'),
  updated_at   = now();

INSERT INTO schema_migrations (version) VALUES ('0004_cursor_gemini_agents') ON CONFLICT DO NOTHING;
