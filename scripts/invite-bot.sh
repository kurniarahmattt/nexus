#!/usr/bin/env bash
# ============================================================================
# scripts/invite-bot.sh — invite a Nexus bot user to a channel.
# Usage: scripts/invite-bot.sh --slug claude-rahmat-backend --channel project-nexus
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

SLUG=""
CHANNEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)    SLUG="$2"; shift 2;;
    --channel) CHANNEL="$2"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

[ -n "$SLUG" ]    || { echo "--slug required" >&2; exit 1; }
[ -n "$CHANNEL" ] || { echo "--channel required" >&2; exit 1; }

if [ -f "${REPO_ROOT}/.env" ]; then set -a; source "${REPO_ROOT}/.env"; set +a; fi

RC_URL="${ROCKETCHAT_URL:-http://localhost:3000}"
RC_ADMIN_USER="${ROCKETCHAT_ADMIN_USERNAME:-admin}"
RC_ADMIN_PASS="${ROCKETCHAT_ADMIN_PASSWORD:-nexus_admin_dev}"

login_resp=$(curl -sfS -X POST "${RC_URL}/api/v1/login" \
  -H "Content-Type: application/json" \
  -d "{\"user\":\"${RC_ADMIN_USER}\",\"password\":\"${RC_ADMIN_PASS}\"}")
TOK=$(echo "$login_resp" | grep -oP '"authToken"\s*:\s*"\K[^"]+')
ADMIN_ID=$(echo "$login_resp" | grep -oP '"userId"\s*:\s*"\K[^"]+')

# Try channels.invite (public) first, then groups.invite (private).
ch_strip="${CHANNEL#\#}"
for endpoint in channels.invite groups.invite; do
  resp=$(curl -sS -X POST "${RC_URL}/api/v1/${endpoint}" \
    -H "X-Auth-Token: $TOK" -H "X-User-Id: $ADMIN_ID" \
    -H "Content-Type: application/json" \
    -d "{\"roomName\":\"${ch_strip}\",\"username\":\"${SLUG}\"}")
  if echo "$resp" | grep -q '"success":true'; then
    echo "[invite] @${SLUG} → #${ch_strip} (via ${endpoint})"
    exit 0
  fi
done
echo "[invite] FAILED: check channel name + bot slug. Last resp: $(echo "$resp" | head -c 200)"
exit 1
