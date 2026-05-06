#!/usr/bin/env bash
# ============================================================================
# scripts/create-bridge.sh — provision a remote bridge for a user.
# ============================================================================
# Creates:
#   1. User row if missing.
#   2. RC bot user `@<cli>-<username>` + clears 2FA + captures authToken.
#   3. Agents row with kind='remote', config.bridge {token, cwd, cli_kind}.
#   4. Updates outgoing integration triggerWords to include the new slug.
#
# Usage:
#   scripts/create-bridge.sh --user alice --cwd /home/alice/coding/backend --cli claude
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "${SCRIPT_DIR}")"

# Defaults
CLI="claude"
USERNAME=""
CWD=""
NAME=""   # optional suffix for multi-session per user (e.g. "backend")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USERNAME="$2"; shift 2;;
    --cli)  CLI="$2"; shift 2;;
    --cwd)  CWD="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    *) echo "Unknown arg: $1" >&2; exit 1;;
  esac
done

[ -n "$USERNAME" ] || { echo "--user required" >&2; exit 1; }
[ -n "$CWD" ]      || { echo "--cwd required" >&2; exit 1; }
[[ "$CLI" =~ ^(claude|hermes|cursor|gemini)$ ]] || {
  echo "--cli must be one of: claude hermes cursor gemini" >&2; exit 1; }
if [ -n "$NAME" ] && ! [[ "$NAME" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "--name must be lowercase alnum+dash, starting with alnum" >&2; exit 1
fi

# Load .env
if [ -f "${REPO_ROOT}/.env" ]; then
  set -a; source "${REPO_ROOT}/.env"; set +a
else
  echo ".env missing — run 'make setup'" >&2; exit 1
fi

RC_URL="${ROCKETCHAT_URL:-http://localhost:3000}"
RC_ADMIN_USER="${ROCKETCHAT_ADMIN_USERNAME:-admin}"
RC_ADMIN_PASS="${ROCKETCHAT_ADMIN_PASSWORD:-nexus_admin_dev}"
MONGO_CONTAINER="${MONGO_CONTAINER:-nexus-mongo}"
PG_CONTAINER="${POSTGRES_CONTAINER:-nexus-postgres}"
PGUSER="${POSTGRES_USER:-nexus}"
PGDB="${POSTGRES_DB:-nexus}"

if [ -n "$NAME" ]; then
  SLUG="${CLI}-${USERNAME}-${NAME}"
  BOT_DISPLAY="${CLI^} (${USERNAME}-${NAME})"
else
  SLUG="${CLI}-${USERNAME}"
  BOT_DISPLAY="${CLI^} (${USERNAME})"
fi
# Random per-bot RC password. Only used here to capture authToken via
# /api/v1/login (below). Discarded after — never persisted to our DB.
BOT_PASSWORD="nx-$(openssl rand -base64 18 | tr -d '=+/' | cut -c1-16)"
BRIDGE_TOKEN="$(openssl rand -hex 24)"

# Persist a config template next to the repo so the user can edit + share
# with the bridge CLI. File lives at bridges/<slug>.json.
CONFIG_DIR="${REPO_ROOT}/bridges"
mkdir -p "$CONFIG_DIR"
CONFIG_PATH="${CONFIG_DIR}/${SLUG}.json"

log() { printf "\033[36m[bridge]\033[0m %s\n" "$*"; }
die() { printf "\033[31m[bridge ERR]\033[0m %s\n" "$*" >&2; exit 1; }

# ---- Admin login ----
login_resp=$(curl -sfS -X POST "${RC_URL}/api/v1/login" \
  -H "Content-Type: application/json" \
  -d "{\"user\":\"${RC_ADMIN_USER}\",\"password\":\"${RC_ADMIN_PASS}\"}") \
  || die "admin login failed"
TOK=$(echo "$login_resp" | grep -oP '"authToken"\s*:\s*"\K[^"]+')
ADMIN_ID=$(echo "$login_resp" | grep -oP '"userId"\s*:\s*"\K[^"]+')

# ---- 1. Ensure user row in Postgres ----
# We don't have a RC user for the person (alice/bob are human users who
# already exist in RC with their own accounts). Just ensure a 'users' row;
# find by username first, upsert if missing.
USER_EXISTS=$(docker exec "${PG_CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -At \
  -c "SELECT id FROM users WHERE username = '${USERNAME}';" || echo "")

if [ -z "$USER_EXISTS" ]; then
  log "creating users row for '${USERNAME}' (rocketchat_id=${USERNAME}-synth)..."
  docker exec "${PG_CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -v ON_ERROR_STOP=1 \
    -c "INSERT INTO users (rocketchat_id, username, display_name) VALUES
        ('${USERNAME}-synth', '${USERNAME}', '${USERNAME}')
        ON CONFLICT (rocketchat_id) DO NOTHING;" > /dev/null
fi

USER_UUID=$(docker exec "${PG_CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -At \
  -c "SELECT id FROM users WHERE username = '${USERNAME}';")
[ -n "$USER_UUID" ] || die "could not resolve user UUID"

# ---- 2. Create RC bot user ----
log "ensuring RC bot @${SLUG}..."
exists=$(curl -sfS -H "X-Auth-Token: $TOK" -H "X-User-Id: $ADMIN_ID" \
  "${RC_URL}/api/v1/users.info?username=${SLUG}" 2>/dev/null \
  | grep -oP '"success"\s*:\s*\K(true|false)' || echo "false")

if [ "$exists" = "false" ]; then
  body="{\"name\":\"${BOT_DISPLAY}\",\"email\":\"${SLUG}@nexus.local\",\"username\":\"${SLUG}\",\"password\":\"${BOT_PASSWORD}\",\"verified\":true,\"active\":true,\"roles\":[\"bot\",\"user\"],\"joinDefaultChannels\":false,\"requirePasswordChange\":false,\"sendWelcomeEmail\":false}"
  curl -sfS -X POST -H "X-Auth-Token: $TOK" -H "X-User-Id: $ADMIN_ID" \
    -H "Content-Type: application/json" -d "$body" \
    "${RC_URL}/api/v1/users.create" > /dev/null \
    || die "bot creation failed"
fi
BOT_ID=$(curl -sfS -H "X-Auth-Token: $TOK" -H "X-User-Id: $ADMIN_ID" \
  "${RC_URL}/api/v1/users.info?username=${SLUG}" \
  | grep -oP '"_id"\s*:\s*"\K[^"]+' | head -1)
[ -n "$BOT_ID" ] || die "resolved empty bot id"

# Clear 2FA on the bot so it can login with password.
docker exec "${MONGO_CONTAINER}" mongosh rocketchat --quiet --eval "
  db.users.updateOne({username:'${SLUG}'}, {\$unset:{
    'services.email2fa':'','services.totp':'','services.emailCode':''}});
" > /dev/null

# Bot login → authToken
bot_login=$(curl -sfS -X POST "${RC_URL}/api/v1/login" \
  -H "Content-Type: application/json" \
  -d "{\"user\":\"${SLUG}\",\"password\":\"${BOT_PASSWORD}\"}")
BOT_TOKEN=$(echo "$bot_login" | grep -oP '"authToken"\s*:\s*"\K[^"]+')
BOT_UID=$(echo   "$bot_login" | grep -oP '"userId"\s*:\s*"\K[^"]+')
[ -n "$BOT_TOKEN" ] || die "bot login failed"

# ---- 3. Upsert agents row ----
log "upserting agents row (kind=remote)..."

# Persona for remote bridge bots (owned by <username>)
PERSONA="You are @${SLUG}, a Nexus bridge bot that proxies a Claude Code session running on ${USERNAME}'s PC in their workspace ${CWD}. Be concise. Match user's language. The chat is multi-user — check [TEAM CONTEXT] for attribution. You may be addressed by other bridge bots (e.g. another user's @${CLI}-<them>) — respond as a peer collaborator sharing project context. Introduce yourself as '${CLI^} (${USERNAME})' if asked."

docker exec -i "${PG_CONTAINER}" psql -U "${PGUSER}" -d "${PGDB}" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO agents (
  slug, display_name, cli_command, cli_args, rocketchat_username, rocketchat_bot_id,
  kind, owner_user_id, config, enabled
) VALUES (
  '${SLUG}',
  '${BOT_DISPLAY}',
  '${CLI}',
  '[]'::jsonb,
  '${SLUG}',
  '${BOT_ID}',
  'remote',
  '${USER_UUID}'::uuid,
  jsonb_build_object(
    'system_prompt', \$\$${PERSONA}\$\$,
    'auth_token',    '${BOT_TOKEN}',
    'auth_user_id',  '${BOT_UID}',
    'bridge', jsonb_build_object(
      'token',    '${BRIDGE_TOKEN}',
      'cli_kind', '${CLI}',
      'cwd',      '${CWD}'
    )
  ),
  true
)
ON CONFLICT (slug) DO UPDATE SET
  display_name      = EXCLUDED.display_name,
  rocketchat_bot_id = EXCLUDED.rocketchat_bot_id,
  kind              = 'remote',
  owner_user_id     = EXCLUDED.owner_user_id,
  config            = agents.config || EXCLUDED.config,
  enabled           = true,
  updated_at        = now();
SQL

# ---- 4. Update outgoing integration triggerWords ----
log "adding @${SLUG} to integration triggerWords..."
docker exec "${MONGO_CONTAINER}" mongosh rocketchat --quiet --eval "
  const i = db.rocketchat_integrations.findOne({name:'nexus-outgoing'});
  if (!i) { print('integration missing — run make bootstrap first'); quit(1); }
  const set = new Set(i.triggerWords || []);
  set.add('@${SLUG}');
  db.rocketchat_integrations.updateOne({_id: i._id}, {
    \$set: {triggerWords: [...set], _updatedAt: new Date()}
  });
  print('  triggerWords: ' + [...set].join(','));
" 2>&1 | sed 's/^/  /'

# ---- Write config template ----
if [ ! -f "$CONFIG_PATH" ]; then
  cat > "$CONFIG_PATH" <<JSON
{
  "display_name": "${BOT_DISPLAY}",
  "description": "EDIT ME — what this session does in the team",
  "persona": "You are @${SLUG}, a Claude Code session owned by ${USERNAME}, running on their PC in ${CWD}.\n\n- Be concise. Match the user's language.\n- The chat is multi-user; watch [TEAM CONTEXT] for attribution.\n- Other bots (other users' @${CLI}-<them>, or shared @${CLI}) may address you directly — respond as a peer collaborator who knows ${USERNAME}'s part of the project.\n- Introduce yourself as \"${BOT_DISPLAY}\" if asked.\n\nEDIT THIS FILE (${CONFIG_PATH}) then restart the bridge.",
  "model": "sonnet-4-6",
  "cwd": "${CWD}"
}
JSON
  log "wrote config template: ${CONFIG_PATH}"
fi

# ---- Summary ----
echo ""
log "bridge '${SLUG}' ready."
echo ""
echo "  SLUG:    ${SLUG}"
echo "  BOT:     @${SLUG}  →  ${BOT_DISPLAY}"
echo "  SERVER:  ws://$(hostname -I | awk '{print $1}'):4000/bridge"
echo "  TOKEN:   ${BRIDGE_TOKEN}"
echo "  CWD:     ${CWD}"
echo "  CLI:     ${CLI}"
echo "  CONFIG:  ${CONFIG_PATH}"
echo ""
echo "  1) Edit the config file above — persona, display_name, description."
echo "  2) Hand the token + config to ${USERNAME} (it contains secrets)."
echo "  3) On ${USERNAME}'s PC:"
echo "       NEXUS_BRIDGE_TOKEN=${BRIDGE_TOKEN} \\"
echo "       bun packages/nexus-bridge/bin/nexus-bridge.ts \\"
echo "         --config ./${SLUG}.json \\"
echo "         --server ws://<nexus-host>:4000/bridge"
echo "  4) Invite bot to a channel:"
echo "       make invite-bot SLUG=${SLUG} CHANNEL=<channel-name>"
echo ""
