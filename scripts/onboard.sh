#!/usr/bin/env bash
# ============================================================================
# scripts/onboard.sh — Nexus host one-shot interactive setup.
# ============================================================================
# Walks the operator through: prerequisites check → .env generation →
# dependency install → docker stack up → host services → bootstrap.
# Idempotent: re-runs are safe; existing .env is preserved unless the user
# explicitly opts to regenerate.
# ============================================================================

set -euo pipefail

# ---- pretty output ----------------------------------------------------------

C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
C_CYAN=$'\033[36m'; C_BLUE=$'\033[34m'

step()  { printf "\n${C_CYAN}${C_BOLD}┌─[%s/%s]─ %s${C_RESET}\n" "$1" "$TOTAL_STEPS" "$2"; }
ok()    { printf "  ${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn()  { printf "  ${C_YELLOW}!${C_RESET} %s\n" "$*"; }
err()   { printf "  ${C_RED}✗${C_RESET} %s\n" "$*" >&2; }
info()  { printf "  ${C_DIM}%s${C_RESET}\n" "$*"; }
ask()   { printf "  ${C_BLUE}?${C_RESET} %s " "$*"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TOTAL_STEPS=7

# ---- header -----------------------------------------------------------------

cat <<EOF

${C_BOLD}Welcome to Nexus.${C_RESET}

This wizard sets up Nexus on this machine as the team host. Five minutes
end-to-end if your prerequisites are already in place.

${C_DIM}If you only want your local AI partner to JOIN an existing Nexus, use
the bridge flow instead — see https://kurniarahmattt.github.io/nexus/guide/quick-start-bridge${C_RESET}

EOF

# ---- step 1: prerequisites --------------------------------------------------

step 1 "Checking prerequisites"

missing=()
have() { command -v "$1" >/dev/null 2>&1; }

for bin in docker bun openssl tmux git; do
  if have "$bin"; then ok "$bin"; else err "$bin (missing)"; missing+=("$bin"); fi
done
if have docker && docker compose version >/dev/null 2>&1; then
  ok "docker compose plugin"
else
  err "docker compose plugin (missing)"
  missing+=("docker-compose-plugin")
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo
  err "Missing: ${missing[*]}"
  cat <<EOF

  Install hints:
    Bun:    curl -fsSL https://bun.sh/install | bash
    Docker: https://docs.docker.com/engine/install/
    tmux:   sudo apt install -y tmux   (Debian/Ubuntu)
            brew install tmux           (macOS)

EOF
  exit 1
fi

# Disk + memory soft check (warning only).
if df -k . | awk 'NR==2 {exit ($4 < 6*1024*1024)}'; then
  ok "disk: ≥ 6 GB free"
else
  warn "disk: less than 6 GB free; the stack uses ~5 GB"
fi
if free -k | awk '/^Mem:/ {exit ($2 < 5.5*1024*1024)}'; then
  ok "memory: ≥ 6 GB"
else
  warn "memory: less than 6 GB; Rocket.Chat may be slow"
fi

# Port helper — used by step 3. ss is on most modern Linux distros; nc
# and bash /dev/tcp are universal fallbacks.
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH 2>/dev/null | awk '{print $4}' | grep -E ":${1}\$" >/dev/null
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  else
    (echo > "/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
  fi
}

# Find next free port starting from $1, advancing by $2 (default 1).
find_free_port() {
  local p=$1 step=${2:-1}
  while port_in_use "$p"; do p=$((p + step)); done
  printf '%s' "$p"
}

# ---- step 2: .env -----------------------------------------------------------

step 2 "Configuring .env"

if [ -f .env ]; then
  warn ".env already exists"
  ask "Regenerate? Existing values will be overwritten. [y/N]"
  read -r ans
  case "${ans:-N}" in
    y|Y|yes|YES) info "regenerating .env from template"; cp .env.example .env ;;
    *)           ok "keeping existing .env"; ;;
  esac
else
  cp .env.example .env
  ok "created .env from template"
fi

# Helpers to update .env in-place.
set_env() {
  local key="$1" val="$2"
  # POSIX-portable sed replacement; handle | as separator since values may contain /
  if grep -qE "^${key}=" .env; then
    # Use a delimiter unlikely to appear in values
    python3 -c "
import sys, re
key, val = sys.argv[1], sys.argv[2]
with open('.env') as f: lines = f.readlines()
out = []
for ln in lines:
    if ln.startswith(key + '='):
        out.append(f'{key}={val}\n')
    else:
        out.append(ln)
with open('.env', 'w') as f: f.writelines(out)
" "$key" "$val"
  else
    printf "%s=%s\n" "$key" "$val" >> .env
  fi
}

current_env() {
  # Tolerate missing keys: grep returns 1 if no match, which under
  # set -euo pipefail would silently kill the wizard. Wrap to always
  # exit 0 with empty output if the key isn't present yet.
  local v
  v=$(grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true)
  printf '%s' "$v"
}

# Workspace root.
default_ws="$HOME/coding"
existing_ws="$(current_env NEXUS_WORKSPACE_ROOT)"
case "$existing_ws" in
  /path/to/*|"")  ws_prompt="$default_ws" ;;
  *)              ws_prompt="$existing_ws" ;;
esac
ask "Where is the parent dir of your projects? [${ws_prompt}]"
read -r ws
ws="${ws:-$ws_prompt}"
case "$ws" in
  /*) ;;
  *)  err "must be absolute. Got: $ws"; exit 1 ;;
esac
[ -d "$ws" ] || warn "$ws does not exist yet (you can create it later)"
set_env NEXUS_WORKSPACE_ROOT "$ws"
ok "NEXUS_WORKSPACE_ROOT=$ws"

# Generate secrets.
gen_secret() { openssl rand -base64 24 | tr -d '\n=+/' | cut -c1-32; }
gen_token()  { openssl rand -hex 24; }

regen_if_dev() {
  local key="$1" generator="$2"
  local cur; cur="$(current_env "$key")"
  case "$cur" in
    *_dev|*_dev_*|sk-replace-me|nexus_admin_dev|nexus_dev_pass|nexus_webhook_dev_secret|nexus_dev_session_secret_at_least_16)
      local fresh; fresh="$($generator)"
      set_env "$key" "$fresh"
      ok "$key (random secret generated)"
      ;;
    "")
      local fresh; fresh="$($generator)"
      set_env "$key" "$fresh"
      ok "$key (random secret generated)"
      ;;
    *)
      ok "$key (existing value preserved)"
      ;;
  esac
}
regen_if_dev ROCKETCHAT_ADMIN_PASSWORD gen_secret
regen_if_dev POSTGRES_PASSWORD          gen_secret
regen_if_dev NEXUS_WEBHOOK_TOKEN        gen_token
regen_if_dev NEXUS_SESSION_SECRET       gen_token
regen_if_dev NEXUS_ADMIN_TOKEN          gen_token

# Re-derive DATABASE_URL with the latest password.
new_pg_pw="$(current_env POSTGRES_PASSWORD)"
new_pg_user="$(current_env POSTGRES_USER)"
new_pg_db="$(current_env POSTGRES_DB)"
set_env DATABASE_URL "postgresql://${new_pg_user:-nexus}:${new_pg_pw}@localhost:5433/${new_pg_db:-nexus}"
ok "DATABASE_URL updated"

# LLM key (optional).
existing_llm_key="$(current_env MEM0_LLM_API_KEY)"
case "$existing_llm_key" in
  sk-replace-me|"")
    ask "OpenAI/Anthropic API key for Mem0 (or 'skip'; can edit .env later):"
    read -r llm_key
    case "${llm_key:-skip}" in
      skip|SKIP|"") warn "Mem0 will use the placeholder key — semantic recall won't work until you set MEM0_LLM_API_KEY in .env" ;;
      *)            set_env MEM0_LLM_API_KEY "$llm_key"; ok "MEM0_LLM_API_KEY set" ;;
    esac
    ;;
  *) ok "MEM0_LLM_API_KEY (existing value preserved)" ;;
esac

# ---- step 3: port reconciliation -------------------------------------------
# We do this AFTER the .env is in place so we can read the configured
# values, prompt the user to relocate any that clash with another
# process on this machine, and write back the chosen ports — including
# the URLs that depend on them (DATABASE_URL, REDIS_URL, MEM0_API_URL,
# ROCKETCHAT_URL, NEXUS_PUBLIC_URL).
#
# This is non-destructive to other projects running on the host: we
# only ever change the port Nexus uses, never kill or move someone
# else's process.

step 3 "Reconciling host ports"

# Maps a Nexus role to its .env key + sensible default + step size.
# We probe in this order; each role's chosen port is written back to .env.
declare -a PORT_KEYS=(GATEWAY_PORT COMPOSER_PORT RUNTIME_PORT
                      MEM0_HOST_PORT POSTGRES_HOST_PORT REDIS_HOST_PORT
                      MONGO_HOST_PORT ROCKETCHAT_HOST_PORT)
declare -A PORT_LABEL=(
  [GATEWAY_PORT]="nexus-gateway"
  [COMPOSER_PORT]="nexus-composer"
  [RUNTIME_PORT]="nexus-runtime"
  [MEM0_HOST_PORT]="mem0-api"
  [POSTGRES_HOST_PORT]="Postgres"
  [REDIS_HOST_PORT]="Redis"
  [MONGO_HOST_PORT]="MongoDB"
  [ROCKETCHAT_HOST_PORT]="Rocket.Chat"
)
declare -A PORT_DEFAULT=(
  [GATEWAY_PORT]=4000  [COMPOSER_PORT]=4001  [RUNTIME_PORT]=4002
  [MEM0_HOST_PORT]=4100
  [POSTGRES_HOST_PORT]=5433  [REDIS_HOST_PORT]=6380  [MONGO_HOST_PORT]=27017
  [ROCKETCHAT_HOST_PORT]=3000
)
# Step sizes give us pleasant rollovers (4000 → 4010 → 4020).
declare -A PORT_STEP=(
  [GATEWAY_PORT]=10  [COMPOSER_PORT]=10  [RUNTIME_PORT]=10
  [MEM0_HOST_PORT]=10
  [POSTGRES_HOST_PORT]=10  [REDIS_HOST_PORT]=10  [MONGO_HOST_PORT]=10
  [ROCKETCHAT_HOST_PORT]=10
)

declare -A PICKED_PORT
any_relocation=false

for key in "${PORT_KEYS[@]}"; do
  cur="$(current_env "$key")"
  cur="${cur:-${PORT_DEFAULT[$key]}}"
  label="${PORT_LABEL[$key]}"
  if port_in_use "$cur"; then
    suggested="$(find_free_port $((cur + ${PORT_STEP[$key]})) ${PORT_STEP[$key]})"
    warn "$label port $cur is in use by another process"
    ask "Move Nexus's $label to $suggested instead? [Y/n]"
    read -r ans
    case "${ans:-Y}" in
      n|N|no|NO)
        err "cannot continue while $cur is taken; free it manually and re-run."
        exit 1
        ;;
      *)
        set_env "$key" "$suggested"
        PICKED_PORT[$key]="$suggested"
        ok "$key=$suggested"
        any_relocation=true
        ;;
    esac
  else
    PICKED_PORT[$key]="$cur"
    ok "$label port $cur is free"
  fi
done

# Re-derive URLs that embed any of the ports we just settled.
# Run UNCONDITIONALLY (even when no_relocation): the wizard might be
# running on a stale .env where the *_HOST_PORT vars were already
# relocated by a previous attempt but the dependent URLs (DATABASE_URL,
# REDIS_URL, etc.) were never updated. Idempotent — writing the same
# value is a no-op.
info "syncing dependent URLs in .env to match the current ports..."

pg_user="$(current_env POSTGRES_USER)"; pg_user="${pg_user:-nexus}"
pg_db="$(current_env POSTGRES_DB)"; pg_db="${pg_db:-nexus}"
pg_pw="$(current_env POSTGRES_PASSWORD)"
expected_database_url="postgresql://${pg_user}:${pg_pw}@localhost:${PICKED_PORT[POSTGRES_HOST_PORT]}/${pg_db}"
if [ "$(current_env DATABASE_URL)" != "$expected_database_url" ]; then
  set_env DATABASE_URL "$expected_database_url"
  ok "DATABASE_URL synced (port ${PICKED_PORT[POSTGRES_HOST_PORT]})"
fi
# Mirror in POSTGRES_PORT (sometimes consumed standalone).
if [ "$(current_env POSTGRES_PORT)" != "${PICKED_PORT[POSTGRES_HOST_PORT]}" ]; then
  set_env POSTGRES_PORT "${PICKED_PORT[POSTGRES_HOST_PORT]}"
fi

expected_redis="redis://localhost:${PICKED_PORT[REDIS_HOST_PORT]}"
if [ "$(current_env REDIS_URL)" != "$expected_redis" ]; then
  set_env REDIS_URL "$expected_redis"
  ok "REDIS_URL synced"
fi
if [ "$(current_env REDIS_PORT)" != "${PICKED_PORT[REDIS_HOST_PORT]}" ]; then
  set_env REDIS_PORT "${PICKED_PORT[REDIS_HOST_PORT]}"
fi

expected_mem0="http://localhost:${PICKED_PORT[MEM0_HOST_PORT]}"
if [ "$(current_env MEM0_API_URL)" != "$expected_mem0" ]; then
  set_env MEM0_API_URL "$expected_mem0"
  ok "MEM0_API_URL synced"
fi

expected_rc="http://localhost:${PICKED_PORT[ROCKETCHAT_HOST_PORT]}"
if [ "$(current_env ROCKETCHAT_URL)" != "$expected_rc" ]; then
  set_env ROCKETCHAT_URL "$expected_rc"
  ok "ROCKETCHAT_URL synced"
fi

# Update NEXUS_PUBLIC_URL only if it currently points at localhost
# (with a port suffix). For prod URLs (https://nexus.example.com), the
# admin pre-set that and the gateway port behind a reverse proxy is
# already the proxy's choice — leave it alone.
cur_pub="$(current_env NEXUS_PUBLIC_URL)"
case "$cur_pub" in
  *localhost:[0-9]*)
    new_pub=$(printf '%s' "$cur_pub" | sed -E "s|:[0-9]+\$|:${PICKED_PORT[GATEWAY_PORT]}|")
    if [ "$cur_pub" != "$new_pub" ]; then
      set_env NEXUS_PUBLIC_URL "$new_pub"
      ok "NEXUS_PUBLIC_URL=$new_pub"
    fi
    ;;
esac

# Always sync NEXUS_WEBHOOK_URL with the current GATEWAY_PORT — even if
# nothing was relocated. The bootstrap script (step 7) uses this to
# configure RC's outgoing webhook; if the wizard skipped it, RC would
# call the default :4000 which may be a different process now.
expected_webhook="http://host.docker.internal:${PICKED_PORT[GATEWAY_PORT]}/webhook"
current_webhook="$(current_env NEXUS_WEBHOOK_URL)"
if [ "$current_webhook" != "$expected_webhook" ]; then
  set_env NEXUS_WEBHOOK_URL "$expected_webhook"
  ok "NEXUS_WEBHOOK_URL=${expected_webhook}"
fi

# ---- step 4: install --------------------------------------------------------

step 4 "Installing JS dependencies"
bun install --silent
ok "dependencies installed"

# Build the per-user nexus-bridge bundle so the gateway can serve it at
# /admin/download/nexus-bridge.js. Without this, every `nexus onboard`
# attempt against this host would fail to fetch the bundle. We do it
# unconditionally — `bun build` is fast (~1s), idempotent, and the
# alternative is a confusing "could not fetch bundle" error during a
# dev's first connection.
info "building nexus-bridge bundle (served at /admin/download/nexus-bridge.js)..."
mkdir -p packages/nexus-bridge/dist
bun build packages/nexus-bridge/bin/nexus-bridge.ts \
  --target=bun \
  --outfile=packages/nexus-bridge/dist/nexus-bridge.js \
  --silent 2>&1 | sed 's/^/  /' || warn "bridge bundle build had warnings — check by running \`make build-bridge\`"
if [ -f packages/nexus-bridge/dist/nexus-bridge.js ]; then
  ok "bridge bundle built ($(wc -c < packages/nexus-bridge/dist/nexus-bridge.js | tr -d ' ') bytes)"
else
  err "bridge bundle missing after build"
  exit 1
fi

# ---- step 5: docker stack ---------------------------------------------------

step 5 "Starting docker stack"
docker compose up -d 2>&1 | sed 's/^/  /'
info "waiting for Rocket.Chat to become healthy (up to ~90s)..."
for i in $(seq 1 45); do
  status="$(docker inspect nexus-rocketchat --format '{{.State.Health.Status}}' 2>/dev/null || echo 'starting')"
  if [ "$status" = "healthy" ]; then
    ok "Rocket.Chat is healthy"
    break
  fi
  printf "    %-2d/45  status=%s\r" "$i" "$status"
  sleep 2
done
echo
if [ "$(docker inspect nexus-rocketchat --format '{{.State.Health.Status}}' 2>/dev/null)" != "healthy" ]; then
  err "Rocket.Chat is not healthy yet. Tail logs with: make logs-rocketchat"
  exit 1
fi

# ---- step 6: host services --------------------------------------------------

step 6 "Starting host services (gateway / composer / runtime)"
if tmux has-session -t nexus 2>/dev/null; then
  warn "tmux session 'nexus' already exists — leaving it as-is"
else
  make services-up 2>&1 | sed 's/^/  /'
fi
runtime_port="${PICKED_PORT[RUNTIME_PORT]:-4002}"
info "waiting for runtime to respond on :${runtime_port}..."
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://localhost:${runtime_port}/health" >/dev/null 2>&1; then
    ok "host services responding"
    break
  fi
  sleep 1
done

# ---- step 7: bootstrap ------------------------------------------------------

step 7 "Bootstrapping Rocket.Chat (admin user, bots, test channel)"
make bootstrap 2>&1 | sed 's/^/  /'

# ---- done -------------------------------------------------------------------

rc_port="${PICKED_PORT[ROCKETCHAT_HOST_PORT]:-3000}"
gw_port="${PICKED_PORT[GATEWAY_PORT]:-4000}"

cat <<EOF

${C_GREEN}${C_BOLD}✓ Nexus is up.${C_RESET}

  ${C_BOLD}Next steps:${C_RESET}
  • Open ${C_CYAN}http://localhost:${rc_port}${C_RESET}
    Admin login printed in the bootstrap output above.
  • Test:  in the #nexus-test channel, type ${C_CYAN}@claude hello${C_RESET}
  • Status anytime:  ${C_CYAN}make health${C_RESET} / ${C_CYAN}make services-status${C_RESET}
  • Logs:  ${C_CYAN}make logs${C_RESET}

  ${C_BOLD}Onboard a teammate's AI (issue an invite URL):${C_RESET}
    make issue-invite USER=<their-username> CHANNELS=<channel-name>

  Point them at:
    https://kurniarahmattt.github.io/nexus/guide/quick-start-bridge

  Your gateway URL:  ws://<this-host>:${gw_port}/bridge

EOF
