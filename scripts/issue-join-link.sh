#!/usr/bin/env bash
# ============================================================================
# scripts/issue-join-link.sh — issue a fresh join URL for an existing bridge.
# ============================================================================
# Use when:
#   • The original join URL printed by `make create-bridge` was lost.
#   • The original URL expired or was already consumed by someone.
#   • Rotating credentials (issue a new code; the old config keeps working
#     for any already-connected bridge — only the *exchange* code changes).
#
# Usage:
#   make issue-join-link SLUG=claude-alice-backend
#   NEXUS_JOIN_TTL_HOURS=4 make issue-join-link SLUG=claude-alice-backend
# ============================================================================

set -euo pipefail

[ -n "${SLUG:-}" ] || { echo "SLUG=<slug> required (e.g. SLUG=claude-alice-backend)"; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"
[ -f "${REPO_ROOT}/.env" ] && { set -a; . "${REPO_ROOT}/.env"; set +a; }

PG_CONTAINER="${POSTGRES_CONTAINER:-nexus-postgres}"
PGUSER="${POSTGRES_USER:-nexus}"
PGDB="${POSTGRES_DB:-nexus}"
PUBLIC_URL="${NEXUS_PUBLIC_URL:-http://localhost:4000}"
TTL_HOURS="${NEXUS_JOIN_TTL_HOURS:-24}"

# Verify the bridge exists.
exists=$(docker exec "${PG_CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -At \
  -c "SELECT 1 FROM agents WHERE slug = '${SLUG}' AND kind = 'remote';" || echo "")
if [ -z "$exists" ]; then
  echo "✗ no remote bridge with slug '${SLUG}'."
  echo "  list:  make list-bridges"
  exit 1
fi

JOIN_CODE="$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-22)"

docker exec -i "${PG_CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -v ON_ERROR_STOP=1 > /dev/null <<SQL
INSERT INTO bridge_join_codes (code, agent_slug, expires_at)
VALUES ('${JOIN_CODE}', '${SLUG}', now() + interval '${TTL_HOURS} hours');
SQL

JOIN_URL="${PUBLIC_URL}/join/${JOIN_CODE}"

cat <<EOF

  ${JOIN_URL}

  Slug:     ${SLUG}
  Expires:  ${TTL_HOURS} hours from now
  One-shot: yes

  Send to the developer via a private channel (Signal / password manager
  / encrypted email). On their laptop they run:

    nexus onboard ${JOIN_URL}

EOF
