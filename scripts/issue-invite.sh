#!/usr/bin/env bash
# ============================================================================
# scripts/issue-invite.sh — issue a bridge-creation invite for a developer.
# ============================================================================
# Use to give a teammate the ability to spin up a NEW bridge for themselves
# without you running `make create-bridge` for each one. The invite carries
# constraints (allowed CLIs, slug prefix, expiry, max uses).
#
# Usage:
#   make issue-invite USER=alice
#   make issue-invite USER=alice CLI=claude
#   make issue-invite USER=alice CLI=claude,cursor
#   NEXUS_INVITE_TTL_HOURS=72 NEXUS_INVITE_MAX_USES=3 make issue-invite USER=alice
# ============================================================================

set -euo pipefail

[ -n "${USER:-}" ] || { echo "USER=<username> required (the developer who'll consume the invite)"; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"
[ -f "${REPO_ROOT}/.env" ] && { set -a; . "${REPO_ROOT}/.env"; set +a; }

PG_CONTAINER="${POSTGRES_CONTAINER:-nexus-postgres}"
PGUSER="${POSTGRES_USER:-nexus}"
PGDB="${POSTGRES_DB:-nexus}"
PUBLIC_URL="${NEXUS_PUBLIC_URL:-http://localhost:4000}"
TTL_HOURS="${NEXUS_INVITE_TTL_HOURS:-72}"
MAX_USES="${NEXUS_INVITE_MAX_USES:-1}"

# Parse comma-separated CLI list.
ALLOWED_CLIS="${CLI:-}"
if [ -n "$ALLOWED_CLIS" ]; then
  ALLOWED_CLIS_SQL="ARRAY[$(echo "$ALLOWED_CLIS" | sed "s/[^,]*/'&'/g")]::text[]"
else
  ALLOWED_CLIS_SQL="'{}'::text[]"
fi

# Optional slug prefix.
SLUG_PREFIX_SQL="NULL"
if [ -n "${SLUG_PREFIX:-}" ]; then
  SLUG_PREFIX_SQL="'${SLUG_PREFIX}'"
fi

# Optional default channels (comma-separated). Bot will be auto-invited
# to each one on bridge creation.
DEFAULT_CHANNELS_SQL="'{}'::text[]"
if [ -n "${CHANNELS:-}" ]; then
  DEFAULT_CHANNELS_SQL="ARRAY[$(echo "$CHANNELS" | sed "s/[^,]*/'&'/g")]::text[]"
fi

# Resolve user uuid (may be NULL — invite still works, owner_user_id resolved at consume time).
USER_UUID=$(docker exec "${PG_CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -At \
  -c "SELECT id FROM users WHERE username = '${USER}';" 2>/dev/null || echo "")

ALLOWED_USER_SQL="NULL"
if [ -n "$USER_UUID" ]; then
  ALLOWED_USER_SQL="'${USER_UUID}'::uuid"
fi

INVITE_CODE="$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-28)"

docker exec -i "${PG_CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -v ON_ERROR_STOP=1 > /dev/null <<SQL
INSERT INTO bridge_invites
  (code, allowed_user_id, allowed_cli_kinds, slug_prefix, default_channels, expires_at, max_uses, notes)
VALUES (
  '${INVITE_CODE}',
  ${ALLOWED_USER_SQL},
  ${ALLOWED_CLIS_SQL},
  ${SLUG_PREFIX_SQL},
  ${DEFAULT_CHANNELS_SQL},
  now() + interval '${TTL_HOURS} hours',
  ${MAX_USES},
  'issued for ${USER}'
);
SQL

INVITE_URL="${PUBLIC_URL}/invite/${INVITE_CODE}"

cat <<EOF

  ${INVITE_URL}

  For:        ${USER}
  CLIs:       ${ALLOWED_CLIS:-any}
  Prefix:     ${SLUG_PREFIX:-(no constraint)}
  Channels:   ${CHANNELS:-(none — admin will run \`make invite-bot\` after)}
  Expires:    ${TTL_HOURS} hours from now
  Max uses:   ${MAX_USES}

  Send to ${USER} via a private channel. On their laptop they run:

    nexus request-bridge ${INVITE_URL} \\
      --name <role>           \\
      --cwd  /path/on/their/laptop \\
      ${ALLOWED_CLIS:+--cli ${ALLOWED_CLIS%%,*}}

  The CLI POSTs to the URL — the gateway creates a fresh bridge bot for
  them, and prints a one-shot join URL the dev can paste into
  \`nexus onboard\` (or pipe automatically with --auto-join).

EOF
