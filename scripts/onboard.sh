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

TOTAL_STEPS=6

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

# Port availability — fail-fast BEFORE we mutate any state. If any port
# is taken, the stack will die later with EADDRINUSE; better to catch it
# now while .env hasn't been generated and Docker hasn't pulled images.
port_in_use() {
  # ss is on most modern Linux distros; nc is the universal fallback.
  if command -v ss >/dev/null 2>&1; then
    ss -tlnH 2>/dev/null | awk '{print $4}' | grep -E ":${1}\$" >/dev/null
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  else
    # Fallback: bash /dev/tcp probe (always available with bash 4+)
    (echo > "/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
  fi
}

declare -A NEXUS_PORTS=(
  [3000]="Rocket.Chat"
  [27017]="MongoDB"
  [5433]="Postgres"
  [6380]="Redis"
  [4100]="mem0-api"
  [4000]="nexus-gateway"
  [4001]="nexus-composer"
  [4002]="nexus-runtime"
)

port_conflicts=()
for port in "${!NEXUS_PORTS[@]}"; do
  if port_in_use "$port"; then
    port_conflicts+=("$port (${NEXUS_PORTS[$port]})")
  fi
done

if [ ${#port_conflicts[@]} -gt 0 ]; then
  echo
  err "ports already in use: ${port_conflicts[*]}"
  cat <<EOF

  These ports must be free before the wizard continues. Find what's
  holding each port and either stop it or move it to a different port.

  Quick diagnostic:
    ss -tlnp | grep -E ':(3000|27017|5433|6380|4100|4000|4001|4002)\b'

  Common culprits:
    • Old Nexus stack still running         → ${C_CYAN}make services-down && make down${C_RESET}
    • Local Postgres on 5432 (mapped here)  → stop the local pg or change POSTGRES_PORT
    • Other dev servers using 4000/4001     → stop them or move them

  Re-run ${C_CYAN}nexus host-onboard${C_RESET} once the ports are clear.

EOF
  exit 1
fi
ok "all required ports are free"

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

# ---- step 3: install --------------------------------------------------------

step 3 "Installing JS dependencies"
bun install --silent
ok "dependencies installed"

# ---- step 4: docker stack ---------------------------------------------------

step 4 "Starting docker stack"
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

# ---- step 5: host services --------------------------------------------------

step 5 "Starting host services (gateway / composer / runtime)"
if tmux has-session -t nexus 2>/dev/null; then
  warn "tmux session 'nexus' already exists — leaving it as-is"
else
  make services-up 2>&1 | sed 's/^/  /'
fi
info "waiting for runtime to respond..."
for i in $(seq 1 30); do
  if curl -fsS --max-time 2 http://localhost:4002/health >/dev/null 2>&1; then
    ok "host services responding"
    break
  fi
  sleep 1
done

# ---- step 6: bootstrap ------------------------------------------------------

step 6 "Bootstrapping Rocket.Chat (admin user, bots, test channel)"
make bootstrap 2>&1 | sed 's/^/  /'

# ---- done -------------------------------------------------------------------

cat <<EOF

${C_GREEN}${C_BOLD}✓ Nexus is up.${C_RESET}

  ${C_BOLD}Next steps:${C_RESET}
  • Open ${C_CYAN}http://localhost:3000${C_RESET}
    Admin login printed in the bootstrap output above.
  • Test:  in the #nexus-test channel, type ${C_CYAN}@claude hello${C_RESET}
  • Status anytime:  ${C_CYAN}make health${C_RESET} / ${C_CYAN}make services-status${C_RESET}
  • Logs:  ${C_CYAN}make logs${C_RESET}

  ${C_BOLD}Onboard a teammate's AI:${C_RESET}
    make create-bridge USER=<their-username> NAME=<role> CLI=claude \\
      CWD=/path/on/their/laptop

  Send them the printed slug, token, config file, and your gateway URL
  (ws://<this-host>:4000/bridge). Point them at:
  https://kurniarahmattt.github.io/nexus/guide/quick-start-bridge

EOF
