#!/usr/bin/env bash
# ============================================================================
# scripts/join-bridge.sh — connect this developer's local CLI to a Nexus host.
# ============================================================================
# Curl-able installer for developers who DO NOT host Nexus themselves. They
# already have:
#   • a token (issued by the host admin via `make create-bridge`)
#   • a config file (bridges/<slug>.json) sent by the admin
#   • a gateway URL (e.g. wss://nexus.team.com/bridge)
#
# This script downloads the prebuilt nexus-bridge bundle, stages everything
# under ~/.nexus/, optionally registers a systemd user unit for persistence,
# and runs the bridge in the foreground.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/kurniarahmattt/nexus/main/scripts/join-bridge.sh \
#     | bash -s -- --server wss://nexus.team.com/bridge \
#                  --token <token> \
#                  --config ./bridge.json
#
#   bash scripts/join-bridge.sh --server ws://192.168.1.10:4000/bridge \
#                                --token abcd1234... \
#                                --config ./claude-alice-backend.json \
#                                --persistent  # optional systemd unit
# ============================================================================

set -euo pipefail

# ---- pretty -----------------------------------------------------------------

C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
ok()    { printf "${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn()  { printf "${C_YELLOW}!${C_RESET} %s\n" "$*"; }
err()   { printf "${C_RED}✗${C_RESET} %s\n" "$*" >&2; }
info()  { printf "${C_DIM}%s${C_RESET}\n" "$*"; }

usage() {
  cat <<EOF
Usage: join-bridge.sh --server <ws-url> --token <token> --config <path> [--persistent]

  --server      Gateway WebSocket URL (e.g. ws://host:4000/bridge or wss://nexus.example.com/bridge)
  --token       Bridge token from \`make create-bridge\` (host-side)
  --config      Path to the bridges/<slug>.json file the host admin sent you
  --persistent  Optional. Register a systemd user unit to keep the bridge running
                across reboots and reconnects. Linux only.
  -h, --help    Show this help

The script does NOT modify shell rc files. It stages everything under ~/.nexus/.
EOF
}

# ---- args -------------------------------------------------------------------

SERVER=""; TOKEN=""; CONFIG=""; PERSISTENT=false
while [ $# -gt 0 ]; do
  case "$1" in
    --server)     SERVER="$2"; shift 2 ;;
    --token)      TOKEN="$2"; shift 2 ;;
    --config)     CONFIG="$2"; shift 2 ;;
    --persistent) PERSISTENT=true; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            err "unknown arg: $1"; usage; exit 2 ;;
  esac
done

[ -n "$SERVER" ]  || { err "--server is required"; usage; exit 2; }
[ -n "$TOKEN" ]   || { err "--token is required"; usage; exit 2; }
[ -n "$CONFIG" ]  || { err "--config is required"; usage; exit 2; }
[ -f "$CONFIG" ]  || { err "config file not found: $CONFIG"; exit 1; }

case "$SERVER" in
  ws://*|wss://*) ;;
  *) err "--server must be a ws:// or wss:// URL"; exit 2 ;;
esac

# ---- prerequisites ----------------------------------------------------------

if ! command -v bun >/dev/null 2>&1; then
  err "Bun is required but not found in \$PATH."
  echo
  echo "  Install:   curl -fsSL https://bun.sh/install | bash"
  echo "  Then re-run this script."
  exit 1
fi
ok "Bun $(bun --version) found"

if ! command -v curl >/dev/null 2>&1; then
  err "curl is required but not found in \$PATH."
  exit 1
fi

# ---- stage ~/.nexus ---------------------------------------------------------

NEXUS_HOME="${NEXUS_HOME:-$HOME/.nexus}"
mkdir -p "$NEXUS_HOME"

# Read slug from the config to use as a stable filename.
SLUG="$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    cfg = json.load(f)
print(cfg.get('slug') or cfg.get('display_name', 'bridge').lower().replace(' ', '-'))
" "$CONFIG" 2>/dev/null || basename "$CONFIG" .json)"

CONFIG_DEST="${NEXUS_HOME}/${SLUG}.json"
if [ "$(realpath "$CONFIG")" != "$(realpath "$CONFIG_DEST" 2>/dev/null || echo nope)" ]; then
  cp "$CONFIG" "$CONFIG_DEST"
  ok "config staged at $CONFIG_DEST"
fi

# ---- download bundle --------------------------------------------------------

BUNDLE_URL_BASE="${SERVER%/bridge}"
BUNDLE_URL_BASE="${BUNDLE_URL_BASE/ws:\/\//http:\/\/}"
BUNDLE_URL_BASE="${BUNDLE_URL_BASE/wss:\/\//https:\/\/}"
BUNDLE_URL="${BUNDLE_URL_BASE}/admin/download/nexus-bridge.js"
BUNDLE_DEST="${NEXUS_HOME}/nexus-bridge.js"

info "fetching bridge bundle from ${BUNDLE_URL}"
if curl -fsSL --max-time 30 "$BUNDLE_URL" -o "$BUNDLE_DEST.tmp"; then
  mv "$BUNDLE_DEST.tmp" "$BUNDLE_DEST"
  ok "bundle saved to $BUNDLE_DEST ($(wc -c < "$BUNDLE_DEST") bytes)"
else
  err "could not fetch bundle from $BUNDLE_URL"
  echo "  Possible causes:"
  echo "    • Host gateway is offline / unreachable from this network"
  echo "    • The gateway hasn't run \`make build-bridge\` yet"
  echo "    • Your URL has a typo (should end with /bridge for --server)"
  exit 1
fi

# ---- persistence (optional) -------------------------------------------------

if [ "$PERSISTENT" = "true" ]; then
  if [ "$(uname -s)" != "Linux" ]; then
    warn "--persistent currently supports Linux+systemd only. Skipping."
  else
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    UNIT_FILE="$UNIT_DIR/nexus-bridge@${SLUG}.service"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Nexus bridge ($SLUG)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$(command -v bun) ${BUNDLE_DEST} --config ${CONFIG_DEST} --server ${SERVER}
Environment=NEXUS_BRIDGE_TOKEN=${TOKEN}
Restart=on-failure
RestartSec=5
# Avoid leaking the token in journalctl if you grep -v carefully:
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
    ok "systemd unit written to $UNIT_FILE"
    info "to enable: systemctl --user daemon-reload && systemctl --user enable --now nexus-bridge@${SLUG}"
    info "to view logs: journalctl --user -u nexus-bridge@${SLUG} -f"
    exit 0
  fi
fi

# ---- run in foreground ------------------------------------------------------

cat <<EOF

${C_GREEN}${C_BOLD}✓ Bridge ready.${C_RESET}

  Slug:    ${SLUG}
  Server:  ${SERVER}
  Config:  ${CONFIG_DEST}
  Bundle:  ${BUNDLE_DEST}

  ${C_DIM}Press Ctrl-C to stop.${C_RESET}

EOF

exec env NEXUS_BRIDGE_TOKEN="$TOKEN" \
  bun "$BUNDLE_DEST" \
    --config "$CONFIG_DEST" \
    --server "$SERVER"
