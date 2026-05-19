-- ============================================================================
-- Phase 5 — Multi-Agent Expansion (cursor + gemini)
-- ============================================================================
-- Intentionally left blank in the public release. See 0002_seed.sql for
-- the rationale: no default agents at install time; operator creates
-- each bridge explicitly via \`make issue-invite\`.
-- ============================================================================

INSERT INTO schema_migrations (version) VALUES ('0004_cursor_gemini_agents') ON CONFLICT DO NOTHING;
