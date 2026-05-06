-- ============================================================================
-- Phase 6 — MCP Tool Registry seeds.
-- Examples disabled by default; admin enables via Web UI when ready.
-- ============================================================================

INSERT INTO mcp_servers (slug, display_name, command, args, env, description, enabled)
VALUES
  ('filesystem-scratch',
   'Filesystem (scratch workspace)',
   'npx',
   '["-y","@modelcontextprotocol/server-filesystem","/home/kurniarahmat/coding/nexus-scratch"]'::jsonb,
   '{}'::jsonb,
   'Read/write access restricted to the Nexus scratch directory. Safe for demos.',
   false),
  ('fetch-web',
   'Fetch (web URL fetcher)',
   'npx',
   '["-y","@modelcontextprotocol/server-fetch"]'::jsonb,
   '{}'::jsonb,
   'HTTP GET to arbitrary URLs. Useful for web research. No internet = no tool.',
   false),
  ('memory-notes',
   'Memory notes (key-value store)',
   'npx',
   '["-y","@modelcontextprotocol/server-memory"]'::jsonb,
   '{}'::jsonb,
   'Persistent key/value memory for bots. Lives in MCP server process memory.',
   false)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO schema_migrations (version) VALUES ('0007_mcp_seeds') ON CONFLICT DO NOTHING;
