#!/usr/bin/env bash
# ============================================================================
# scripts/bootstrap-rocketchat.sh
# ============================================================================
# Phase 0: once Rocket.Chat is up, call its REST API to:
#   1. Log in as admin (credentials from .env)
#   2. Create the @claude and @hermes bot users
#   3. (Optional) Create the #nexus-test room and invite both bots
#   4. Write rocketchat_bot_id back to Postgres (the agents table)
# Idempotent — safe to run multiple times.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

# Load .env
if [ -f "${REPO_ROOT}/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "${REPO_ROOT}/.env"
  set +a
else
  echo "ERROR: .env not found. Run 'make setup' first."
  exit 1
fi

RC_URL="${ROCKETCHAT_URL:-http://localhost:3000}"
RC_ADMIN_USER="${ROCKETCHAT_ADMIN_USERNAME:-admin}"
RC_ADMIN_PASS="${ROCKETCHAT_ADMIN_PASSWORD:-nexus_admin_dev}"
RC_ADMIN_EMAIL="${ROCKETCHAT_ADMIN_EMAIL:-admin@nexus.local}"

PG_CONTAINER="${POSTGRES_CONTAINER:-nexus-postgres}"
PGUSER="${POSTGRES_USER:-nexus}"
PGDB="${POSTGRES_DB:-nexus}"

log() { printf "\033[36m[bootstrap]\033[0m %s\n" "$*" >&2; }
die() { printf "\033[31m[bootstrap ERROR]\033[0m %s\n" "$*" >&2; exit 1; }

# ---- Sanity: wait for Rocket.Chat to be reachable ----
log "Waiting for Rocket.Chat at ${RC_URL}..."
for i in $(seq 1 60); do
  if curl -sfS -o /dev/null "${RC_URL}/api/info"; then
    log "Rocket.Chat is up."
    break
  fi
  if [ "$i" -eq 60 ]; then
    die "Rocket.Chat not reachable after 5 minutes."
  fi
  sleep 5
done

# ---- Login admin ----
log "Logging in admin (${RC_ADMIN_USER})..."
LOGIN_RESP=$(curl -sfS -X POST "${RC_URL}/api/v1/login" \
  -H "Content-Type: application/json" \
  -d "{\"user\":\"${RC_ADMIN_USER}\",\"password\":\"${RC_ADMIN_PASS}\"}") \
  || die "Admin login failed. Check ROCKETCHAT_ADMIN_* in .env."

AUTH_TOKEN=$(echo "$LOGIN_RESP" | grep -oP '"authToken"\s*:\s*"\K[^"]+')
USER_ID=$(echo   "$LOGIN_RESP" | grep -oP '"userId"\s*:\s*"\K[^"]+')

[ -n "$AUTH_TOKEN" ] || die "Failed to extract authToken from login response."
log "Admin logged in. userId=${USER_ID}"

AUTH_HDR=(-H "X-Auth-Token: ${AUTH_TOKEN}" -H "X-User-Id: ${USER_ID}")

# ---- Skip setup wizard & cloud registration ----
# RC 8.x pushes a 4-step wizard on first browser visit. Step 4 (cloud registration)
# needs an email verification that our dev admin (admin@nexus.local) can't receive.
# RC 8.x admin REST endpoint for settings also requires 2FA token even when
# 2FA disabled, so we bypass via direct Mongo write (watched via oplog → hot reload).
log "Patching wizard/cloud settings via Mongo..."
MONGO_CONTAINER="${MONGO_CONTAINER:-nexus-mongo}"
docker exec "${MONGO_CONTAINER}" mongosh rocketchat --quiet --eval '
  const settings = [
    ["Show_Setup_Wizard", "completed"],
    ["Register_Server", false],
    ["Cloud_Service_Agree_PrivacyTerms", true],
    ["Accounts_UseDNSDomainCheck", false],
    ["Organization_Type", "community"],
    ["Organization_Name", "Nexus Dev"],
    ["Industry", "technologyServices"],
    ["Size", "1"],
    ["Country", "worldwide"],
    ["Website", "http://localhost:3000"],
    ["Server_Type", "privateTeam"],
    ["Allow_Marketing_Emails", false],
    ["Accounts_TwoFactorAuthentication_Enabled", false],
    ["Accounts_TwoFactorAuthentication_By_Email_Enabled", false],
    ["Accounts_TwoFactorAuthentication_By_TOTP_Enabled", false],
    ["Accounts_TwoFactorAuthentication_Enforce_Password_Fallback", false]
  ];
  let updated = 0;
  for (const [k, v] of settings) {
    const r = db.rocketchat_settings.updateOne(
      { _id: k },
      { $set: { value: v, ts: new Date() } },
      { upsert: false }
    );
    if (r.modifiedCount) updated++;
  }
  print("  settings updated: " + updated);
' 2>&1 | sed 's/^/  /'

# ---- Helper: create bot user (idempotent) ----
create_bot() {
  local username="$1"
  local display_name="$2"
  local password="$3"
  local email="${username}@nexus.local"

  # Check existence first
  local exists
  exists=$(curl -sfS "${AUTH_HDR[@]}" \
    "${RC_URL}/api/v1/users.info?username=${username}" \
    | grep -oP '"success"\s*:\s*\K(true|false)' || echo "false")

  if [ "$exists" = "true" ]; then
    log "Bot @${username} already exists — skipping create."
  else
    log "Creating bot @${username}..."
    local body
    body=$(cat <<EOF
{
  "name": "${display_name}",
  "email": "${email}",
  "username": "${username}",
  "password": "${password}",
  "verified": true,
  "active": true,
  "roles": ["bot","user"],
  "joinDefaultChannels": false,
  "requirePasswordChange": false,
  "sendWelcomeEmail": false
}
EOF
)
    curl -sfS -X POST "${AUTH_HDR[@]}" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "${RC_URL}/api/v1/users.create" > /dev/null \
      || die "Failed to create bot @${username}"
    log "Bot @${username} created."
  fi

  # Fetch _id for agents table update
  local info
  info=$(curl -sfS "${AUTH_HDR[@]}" "${RC_URL}/api/v1/users.info?username=${username}")
  local bot_id
  bot_id=$(echo "$info" | grep -oP '"_id"\s*:\s*"\K[^"]+' | head -1)
  [ -n "$bot_id" ] || die "Could not determine bot id for @${username}"
  echo "$bot_id"
}

# ---- Create bots: @claude, @hermes, @cursor, @gemini ----
CLAUDE_BOT_ID=$(create_bot "claude" "Claude Code"  "${RC_BOT_CLAUDE_PASSWORD:-nexus_bot_claude}")
HERMES_BOT_ID=$(create_bot "hermes" "Hermes Agent" "${RC_BOT_HERMES_PASSWORD:-nexus_bot_hermes}")
CURSOR_BOT_ID=$(create_bot "cursor" "Cursor Agent" "${RC_BOT_CURSOR_PASSWORD:-nexus_bot_cursor}")
GEMINI_BOT_ID=$(create_bot "gemini" "Gemini CLI"   "${RC_BOT_GEMINI_PASSWORD:-nexus_bot_gemini}")

log "claude bot rocketchat_id = ${CLAUDE_BOT_ID}"
log "hermes bot rocketchat_id = ${HERMES_BOT_ID}"
log "cursor bot rocketchat_id = ${CURSOR_BOT_ID}"
log "gemini bot rocketchat_id = ${GEMINI_BOT_ID}"

# ---- Write bot ids back to Postgres ----
log "Updating agents.rocketchat_bot_id in Postgres..."
docker exec -i "${PG_CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -v ON_ERROR_STOP=1 <<SQL
UPDATE agents SET rocketchat_bot_id = '${CLAUDE_BOT_ID}', updated_at = now()
  WHERE slug = 'claude';
UPDATE agents SET rocketchat_bot_id = '${HERMES_BOT_ID}', updated_at = now()
  WHERE slug = 'hermes';
UPDATE agents SET rocketchat_bot_id = '${CURSOR_BOT_ID}', updated_at = now()
  WHERE slug = 'cursor';
UPDATE agents SET rocketchat_bot_id = '${GEMINI_BOT_ID}', updated_at = now()
  WHERE slug = 'gemini';
SELECT slug, rocketchat_username, rocketchat_bot_id FROM agents ORDER BY slug;
SQL

# ---- Create test channel #nexus-test ----
ROOM_NAME="${NEXUS_TEST_ROOM:-nexus-test}"
log "Ensuring test channel #${ROOM_NAME} exists..."
existing=$(curl -sfS "${AUTH_HDR[@]}" \
  "${RC_URL}/api/v1/channels.info?roomName=${ROOM_NAME}" \
  | grep -oP '"success"\s*:\s*\K(true|false)' || echo "false")

if [ "$existing" = "true" ]; then
  log "Channel #${ROOM_NAME} already exists."
else
  body=$(cat <<EOF
{
  "name": "${ROOM_NAME}",
  "members": ["claude","hermes"]
}
EOF
)
  curl -sfS -X POST "${AUTH_HDR[@]}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${RC_URL}/api/v1/channels.create" > /dev/null \
    || die "Failed to create test channel."
  log "Channel #${ROOM_NAME} created with @claude + @hermes invited."
fi

# ---- Login bots, persist authTokens to Postgres.agents.config ----
bot_login() {
  local username="$1"
  local password="$2"
  local resp
  resp=$(curl -sfS -X POST "${RC_URL}/api/v1/login" \
    -H "Content-Type: application/json" \
    -d "{\"user\":\"${username}\",\"password\":\"${password}\"}")
  local tok uid
  tok=$(echo "$resp" | grep -oP '"authToken"\s*:\s*"\K[^"]+')
  uid=$(echo "$resp" | grep -oP '"userId"\s*:\s*"\K[^"]+')
  [ -n "$tok" ] && [ -n "$uid" ] || die "Failed to login bot @${username}"
  echo "${tok}|${uid}"
}

# Strip any email/TOTP 2FA flags that may have been attached to bot users by RC
# defaults. Dev-only — we want bots to log in with plain username+password.
log "Clearing 2FA flags on bot users..."
docker exec "${MONGO_CONTAINER}" mongosh rocketchat --quiet --eval '
  const r = db.users.updateMany(
    { username: { $in: ["claude", "hermes", "cursor", "gemini"] } },
    { $unset: {
        "services.email2fa": "",
        "services.totp": "",
        "services.emailCode": ""
    } }
  );
  print("  bots patched: " + r.modifiedCount);
' 2>&1 | sed "s/^/  /"

log "Logging in bots to capture authTokens..."
CLAUDE_CRED=$(bot_login "claude" "${RC_BOT_CLAUDE_PASSWORD:-nexus_bot_claude}")
HERMES_CRED=$(bot_login "hermes" "${RC_BOT_HERMES_PASSWORD:-nexus_bot_hermes}")
CURSOR_CRED=$(bot_login "cursor" "${RC_BOT_CURSOR_PASSWORD:-nexus_bot_cursor}")
GEMINI_CRED=$(bot_login "gemini" "${RC_BOT_GEMINI_PASSWORD:-nexus_bot_gemini}")

CLAUDE_TOKEN=${CLAUDE_CRED%|*}; CLAUDE_UID=${CLAUDE_CRED#*|}
HERMES_TOKEN=${HERMES_CRED%|*}; HERMES_UID=${HERMES_CRED#*|}
CURSOR_TOKEN=${CURSOR_CRED%|*}; CURSOR_UID=${CURSOR_CRED#*|}
GEMINI_TOKEN=${GEMINI_CRED%|*}; GEMINI_UID=${GEMINI_CRED#*|}

log "Persisting bot credentials to Postgres agents.config..."
docker exec -i "${PG_CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -v ON_ERROR_STOP=1 <<SQL
UPDATE agents SET config = config || jsonb_build_object(
  'auth_token','${CLAUDE_TOKEN}','auth_user_id','${CLAUDE_UID}'), updated_at=now()
  WHERE slug='claude';
UPDATE agents SET config = config || jsonb_build_object(
  'auth_token','${HERMES_TOKEN}','auth_user_id','${HERMES_UID}'), updated_at=now()
  WHERE slug='hermes';
UPDATE agents SET config = config || jsonb_build_object(
  'auth_token','${CURSOR_TOKEN}','auth_user_id','${CURSOR_UID}'), updated_at=now()
  WHERE slug='cursor';
UPDATE agents SET config = config || jsonb_build_object(
  'auth_token','${GEMINI_TOKEN}','auth_user_id','${GEMINI_UID}'), updated_at=now()
  WHERE slug='gemini';
SQL

# ---- Outgoing webhook integration (RC → gateway) ----
# RC 6.13 quirks:
#   a) integrations.create REST schema is strict — MUST include all fields
#      below including `targetRoom`. Mongo direct-insert bypasses the in-memory
#      loader and the integration won't fire, so we must use REST.
#   b) RC skips outgoing integrations for messages authored by the integration's
#      `_createdBy` user (anti-loop protection). REST creates it as admin. So
#      after REST-create we re-point `_createdBy` to `rocket.cat` via Mongo
#      to restore admin's ability to trigger it.
GATEWAY_WEBHOOK_URL="${NEXUS_WEBHOOK_URL:-http://host.docker.internal:4000/webhook}"
WEBHOOK_TOKEN="${NEXUS_WEBHOOK_TOKEN:-nexus_webhook_dev_secret}"
INTEGRATION_NAME="nexus-outgoing"

# Build JSON body safely (jq not required; single-quoted heredoc).
integration_body=$(cat <<JSON
{
  "type":"webhook-outgoing",
  "name":"${INTEGRATION_NAME}",
  "enabled":true,
  "event":"sendMessage",
  "urls":["${GATEWAY_WEBHOOK_URL}"],
  "channel":"all_public_channels,all_private_groups,all_direct_messages",
  "triggerWords":["@claude","@hermes","@cursor","@gemini"],
  "username":"rocket.cat",
  "scriptEnabled":false,
  "script":"",
  "alias":"",
  "avatar":"",
  "emoji":"",
  "token":"${WEBHOOK_TOKEN}",
  "impersonateUser":false,
  "runOnEdits":true,
  "retryFailedCalls":true,
  "retryCount":6,
  "retryDelay":"powers-of-ten",
  "triggerWordAnywhere":true,
  "targetRoom":""
}
JSON
)

# Idempotent: delete any existing integration with this name, then create.
log "Ensuring outgoing integration '${INTEGRATION_NAME}' (REST create)..."
docker exec "${MONGO_CONTAINER}" mongosh rocketchat --quiet --eval "
  const r = db.rocketchat_integrations.deleteMany({name:'${INTEGRATION_NAME}'});
  print('  cleared ' + r.deletedCount + ' existing');
" 2>&1 | sed 's/^/  /'

create_resp=$(curl -sS -X POST "${RC_URL}/api/v1/integrations.create" \
  "${AUTH_HDR[@]}" -H "Content-Type: application/json" -d "$integration_body")
if echo "$create_resp" | grep -q '"success":false'; then
  die "integrations.create failed: $(echo "$create_resp" | head -c 300)"
fi
log "  integration created via REST"

# Re-point _createdBy to rocket.cat so admin's messages trigger it (RC skips
# messages from the integration's owner).
docker exec "${MONGO_CONTAINER}" mongosh rocketchat --quiet --eval "
  const rc = db.users.findOne({username:'rocket.cat'});
  const r = db.rocketchat_integrations.updateOne(
    {name:'${INTEGRATION_NAME}'},
    {\$set: {_createdBy: {_id: rc._id, username: rc.username}, userId: rc._id}}
  );
  print('  _createdBy re-pointed to rocket.cat (modified=' + r.modifiedCount + ')');
" 2>&1 | sed 's/^/  /'

# Force RC's in-memory integration cache to refresh by toggling enabled via
# REST (Mongo direct-writes don't trigger Meteor's livequery reliably in RC 6.13).
INTEGRATION_ID=$(docker exec "${MONGO_CONTAINER}" mongosh rocketchat --quiet --eval "
  print(db.rocketchat_integrations.findOne({name:'${INTEGRATION_NAME}'})._id);
" | tail -1)
curl -sfS -X POST "${RC_URL}/api/v1/integrations.update" \
  "${AUTH_HDR[@]}" -H "Content-Type: application/json" \
  -d "$(echo "$integration_body" | sed "s|\"type\"|\"integrationId\":\"${INTEGRATION_ID}\",\"type\"|")" \
  > /dev/null 2>&1 \
  && log "  RC cache refreshed" \
  || log "  warn: REST update failed (cache may not refresh)"

# Warm Mem0 lazy init so the first user mention isn't blocked by a 90 MB
# HuggingFace model download. Best-effort: tolerate failure (e.g. running
# stack hasn't finished startup) — the first /memories request will still
# trigger init on demand.
MEM0_URL="${MEM0_API_URL:-http://localhost:4100}"
log "Warming Mem0 (lazy init)..."
warm_resp=$(curl -sS --max-time 120 -X POST "${MEM0_URL}/admin/init" 2>&1 || true)
case "$warm_resp" in
  *'"ok":true'*) log "  Mem0 ready" ;;
  *)             log "  warn: Mem0 warmup did not confirm; first request will retry"
                 log "        response: $(echo "$warm_resp" | head -c 200)" ;;
esac

log ""
log "Bootstrap complete."
log "  → Open ${RC_URL} and login as ${RC_ADMIN_USER} / ${RC_ADMIN_PASS}"
log "  → Test channel: #${ROOM_NAME}"
log "  → Outgoing webhook: ${GATEWAY_WEBHOOK_URL} (trigger: @claude, @hermes)"
