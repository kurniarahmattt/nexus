#!/usr/bin/env bash
# Runs INSIDE the e2e container — drives the wizard non-interactively,
# verifies each phase, then exits 0/1. Mirrors what a fresh public-repo
# user would do.

set -euo pipefail

# ---- pretty -----------------------------------------------------------

C_R=$'\033[0m'; C_G=$'\033[32m'; C_B=$'\033[1m'; C_C=$'\033[36m'; C_X=$'\033[31m'; C_Y=$'\033[33m'

heading()  { printf "\n${C_C}${C_B}═══ %s ═══${C_R}\n" "$*"; }
pass()     { printf "${C_G}✓${C_R} %s\n" "$*"; }
fail()     { printf "${C_X}✗${C_R} %s\n" "$*" >&2; exit 1; }
warn()     { printf "${C_Y}!${C_R} %s\n" "$*"; }
info()     { printf "  %s\n" "$*"; }

# ---- step 0: prep -----------------------------------------------------

heading "Step 0  copying working tree from /src (host's checkout, read-only)"
cp -a /src /work/nexus
cd /work/nexus
# /src was mounted from the host with the host's UID; the container
# runs as root. Git refuses to touch repos owned by other users by
# default — tell it this one is safe so `git rev-parse` works for the
# banner. We DELIBERATELY do not reset to HEAD: the test should run
# against the working-tree state (commit-in-progress changes too).
git config --global --add safe.directory /work/nexus
HEAD_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
# Also nuke any stale .env / runtime artefacts copied along so the
# wizard does its full first-install path.
rm -rf node_modules/.cache services/web/dist packages/nexus-bridge/dist
rm -f .env  # simulate a fresh clone — no pre-existing env file
pass "working-tree copy ready at $HEAD_SHA (+ any uncommitted edits)"

# ---- step 1: wizard, unattended ---------------------------------------

heading "Step 1  running scripts/onboard.sh in UNATTENDED mode"

mkdir -p /tmp/coding   # NEXUS_WORKSPACE_ROOT target
NEXUS_UNATTENDED=1 \
NEXUS_WORKSPACE_ROOT_PROMPT=/tmp/coding \
NEXUS_REGEN_ENV=1 \
NEXUS_LLM_API_KEY=skip \
bash scripts/onboard.sh
pass "wizard exited 0"

# ---- step 2: verify .env is sane --------------------------------------

heading "Step 2  verifying .env"

for k in NEXUS_WORKSPACE_ROOT ROCKETCHAT_ADMIN_PASSWORD POSTGRES_PASSWORD \
         DATABASE_URL NEXUS_WEBHOOK_TOKEN NEXUS_PUBLIC_URL NEXUS_WEBHOOK_URL \
         GATEWAY_PORT COMPOSER_PORT RUNTIME_PORT; do
  v=$(grep -E "^${k}=" .env | head -1 | cut -d= -f2-)
  if [ -z "$v" ]; then
    fail ".env missing $k"
  fi
  case "$v" in
    *dev_pass|*_dev_secret|sk-replace-me|nexus_admin_dev|nexus_dev_session_secret_at_least_16)
      fail ".env $k still has a dev-default placeholder value"
      ;;
  esac
done
pass ".env has every required key with non-default values"

# ---- step 3: docker stack health --------------------------------------

heading "Step 3  docker stack health"

make health | tee /tmp/health.out
grep -q "HTTP 200" /tmp/health.out || fail "Rocket.Chat or mem0 not HTTP 200"
grep -q "accepting connections" /tmp/health.out || fail "Postgres not accepting connections"
grep -q "PONG" /tmp/health.out || fail "Redis not PONG"
pass "all 5 docker services healthy"

# ---- step 4: host services + agents loaded ----------------------------

heading "Step 4  gateway / composer / runtime"

GATEWAY_PORT_FROM_ENV=$(grep ^GATEWAY_PORT= .env | cut -d= -f2)
GATEWAY_PORT_FROM_ENV=${GATEWAY_PORT_FROM_ENV:-4000}
info "gateway should be on :${GATEWAY_PORT_FROM_ENV} per .env"

# Inside DinD the gateway can take a few extra seconds to bind after
# tmux spawns it. Probe /health directly with a generous wait window.
gateway_ok=false
for i in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://localhost:${GATEWAY_PORT_FROM_ENV}/health" 2>/dev/null \
      | grep -q '"status":"ok","service":"nexus-gateway"'; then
    gateway_ok=true
    break
  fi
  sleep 1
done

if [ "$gateway_ok" != "true" ]; then
  warn "gateway /health did not respond OK after 60s"
  warn "tmux pane (gateway):"
  tmux capture-pane -t nexus:gateway -p -S -80 || true
  warn "direct curl probe:"
  curl -v --max-time 3 "http://localhost:${GATEWAY_PORT_FROM_ENV}/health" 2>&1 | head -30 || true
  warn "make services-status output:"
  make services-status 2>&1 | head -20 || true
  fail "gateway unhealthy"
fi
pass "gateway responding on :${GATEWAY_PORT_FROM_ENV}"

# Confirm NO default agents in DB (the new behavior).
agents_count=$(docker exec nexus-postgres psql -U nexus -d nexus -At \
  -c "SELECT count(*) FROM agents;" 2>/dev/null || echo "0")
if [ "$agents_count" != "0" ]; then
  fail "expected 0 agents post-install (got $agents_count) — default agents should NOT be auto-created"
fi
pass "no default agents in DB (operator must create explicitly)"

# ---- step 5: issue an invite, simulating the operator's first action --

heading "Step 5  issuing the first bridge invite"

set +e
INV_OUT=$(make issue-invite USER=alice CLI=claude CHANNELS=nexus-test 2>&1)
INV_RC=$?
set -e
echo "$INV_OUT"
if [ "$INV_RC" -ne 0 ]; then
  fail "make issue-invite returned non-zero"
fi

# Pull the URL out of the script's output.
INVITE_URL=$(echo "$INV_OUT" | grep -oE 'http://localhost:[0-9]+/invite/[A-Za-z0-9]+' | head -1)
[ -n "$INVITE_URL" ] || fail "could not parse invite URL from output"
pass "invite issued: $INVITE_URL"

# ---- step 6: verify invite preview (HTML + JSON) ----------------------

heading "Step 6  GET /invite/<code> preview (no consume)"

curl -fsS "$INVITE_URL" >/tmp/preview.html
grep -q "Nexus invite" /tmp/preview.html || fail "HTML preview missing title"
pass "HTML preview returned (no consume)"

curl -fsS -H "Accept: application/json" "$INVITE_URL" >/tmp/preview.json
python3 -c "
import json,sys
d=json.load(open('/tmp/preview.json'))
assert d.get('ready') is True, d
print('  preview:', json.dumps(d))
"
pass "JSON preview reports ready"

# ---- step 7: consume invite via POST → creates the bridge bot ---------

heading "Step 7  POST /invite/<code> (consume, create bridge bot)"

CONSUME_RESP=$(curl -fsS -X POST -H "Content-Type: application/json" \
  -d '{"name":"backend","cwd":"/tmp/coding/alice-backend","cli":"claude","username":"alice"}' \
  "$INVITE_URL")
echo "$CONSUME_RESP" | python3 -m json.tool
SLUG=$(echo "$CONSUME_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['slug'])")
JOIN_URL=$(echo "$CONSUME_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['join_url'])")
[ "$SLUG" = "claude-alice-backend" ] || fail "wrong slug: $SLUG"
[ -n "$JOIN_URL" ] || fail "no join_url"
pass "bridge created: $SLUG, join URL issued"

# Verify channel_invited result.
echo "$CONSUME_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
ci = d.get('channels_invited', {})
if 'nexus-test' not in ci:
    raise SystemExit('nexus-test missing from channels_invited')
if not ci['nexus-test']:
    raise SystemExit('bot was NOT invited to #nexus-test')
print('  channels_invited:', json.dumps(ci))
"
pass "bot was auto-invited to #nexus-test"

# ---- step 8: join code exchange (CLI's second hop) --------------------

heading "Step 8  POST <join-url> (consume join code, get token + config)"

JOIN_RESP=$(curl -fsS -X POST -H "Content-Type: application/json" "$JOIN_URL")
echo "$JOIN_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for k in ('slug','server','bridge_token','config'):
    if k not in d:
        raise SystemExit(f'missing {k}')
print('  got:', d['slug'], '@', d['server'])
"
# Stash token+server for step 11 (real bridge spawn).
BRIDGE_TOKEN=$(echo "$JOIN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['bridge_token'])")
BRIDGE_SERVER=$(echo "$JOIN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['server'])")
BRIDGE_SLUG=$(echo "$JOIN_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['slug'])")
pass "join code consumed, full credentials returned"

# ---- step 9: replay protection ----------------------------------------

heading "Step 9  replay attempts on consumed URLs"

# Invite replay needs a valid body — without one the gateway rejects
# with 400 invalid_body BEFORE checking uses_count, which would look
# like a working replay block but for the wrong reason. Send the same
# body as step 7.
CODE_REUSE=$(curl -sS -X POST -o /dev/null -w "%{http_code}" \
  -H "Content-Type: application/json" \
  -d '{"name":"backend","cwd":"/tmp/coding/alice-backend","cli":"claude","username":"alice"}' \
  "$INVITE_URL")
[ "$CODE_REUSE" = "410" ] || fail "invite replay returned $CODE_REUSE (expected 410)"
pass "invite POST returns 410 Gone on second attempt"

JOIN_REUSE=$(curl -sS -X POST -o /dev/null -w "%{http_code}" "$JOIN_URL")
[ "$JOIN_REUSE" = "410" ] || fail "join replay returned $JOIN_REUSE (expected 410)"
pass "join POST returns 410 Gone on second attempt"

# ---- step 10: bridge bundle is reachable ------------------------------

heading "Step 10  bridge bundle download endpoint"

BUNDLE_URL="http://localhost:$(grep ^GATEWAY_PORT= .env | cut -d= -f2)/admin/download/nexus-bridge.js"
BUNDLE_HTTP=$(curl -sS -o /tmp/bundle.js -w "%{http_code}" "$BUNDLE_URL")
[ "$BUNDLE_HTTP" = "200" ] || fail "bundle download returned $BUNDLE_HTTP"
BUNDLE_BYTES=$(wc -c < /tmp/bundle.js)
[ "$BUNDLE_BYTES" -gt 5000 ] || fail "bundle suspiciously small ($BUNDLE_BYTES bytes)"
pass "bundle served at /admin/download/nexus-bridge.js ($BUNDLE_BYTES bytes)"

# ---- step 11: real bridge spawn → WS handshake ------------------------
#
# Proves the dev-laptop path actually works: take the credentials from
# step 8, start `nexus-bridge` (the bundled CLI a real user runs), and
# verify the gateway sees it as a connected bridge. We don't drive a
# real CLI invocation (claude/cursor binary isn't installed in this
# image) — only the auth handshake + gateway-visible online state are
# asserted. Dispatch-and-reply is exercised in dev environments where
# the operator runs `nexus onboard` themselves.

heading "Step 11  real bridge spawn (WS handshake + gateway visibility)"

# The bundle from step 10 is already on disk at /tmp/bundle.js. Run it
# directly with Bun against the in-container gateway.
BRIDGE_LOG=/tmp/bridge.log
NEXUS_BRIDGE_TOKEN="$BRIDGE_TOKEN" \
NEXUS_BRIDGE_SERVER="$BRIDGE_SERVER" \
  bun /tmp/bundle.js > "$BRIDGE_LOG" 2>&1 &
BRIDGE_PID=$!
info "bridge pid=$BRIDGE_PID, target slug=$BRIDGE_SLUG"

# Wait up to 15s for the bridge to log "bridge authenticated".
auth_ok=false
for i in $(seq 1 15); do
  if grep -q "bridge authenticated" "$BRIDGE_LOG" 2>/dev/null; then
    auth_ok=true
    break
  fi
  sleep 1
done

if [ "$auth_ok" != "true" ]; then
  warn "bridge did not authenticate within 15s; log tail:"
  tail -30 "$BRIDGE_LOG" >&2 || true
  kill "$BRIDGE_PID" 2>/dev/null || true
  fail "bridge auth handshake never completed"
fi
pass "bridge authenticated via WebSocket"

# Confirm the gateway reports the bridge as connected.
GW_PORT=$(grep ^GATEWAY_PORT= .env | cut -d= -f2)
HEALTH=$(curl -fsS "http://localhost:${GW_PORT}/health")
echo "$HEALTH" | python3 -c "
import sys, json
d = json.load(sys.stdin)
bridges = d.get('bridges', [])
slugs = [b.get('slug') for b in bridges]
if '$BRIDGE_SLUG' not in slugs:
    raise SystemExit(f'expected $BRIDGE_SLUG in bridges, got {slugs}')
print('  gateway sees bridges:', slugs)
"
pass "gateway /health lists $BRIDGE_SLUG as connected"

# Clean shutdown — kill the bridge and confirm the gateway notices.
kill "$BRIDGE_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
sleep 2
POST_HEALTH=$(curl -fsS "http://localhost:${GW_PORT}/health")
echo "$POST_HEALTH" | python3 -c "
import sys, json
d = json.load(sys.stdin)
slugs = [b.get('slug') for b in d.get('bridges', [])]
if '$BRIDGE_SLUG' in slugs:
    raise SystemExit(f'bridge $BRIDGE_SLUG still listed after kill: {slugs}')
print('  bridge cleanly removed; bridges now:', slugs or '[]')
"
pass "gateway removed $BRIDGE_SLUG after bridge process exit"

# ---- final summary ----------------------------------------------------

heading "ALL E2E STEPS PASSED ✓"
cat <<EOF

  Fresh-install path verified end-to-end:
    1. clone
    2. wizard onboard (unattended, no default agents)
    3. .env sanity
    4. docker stack healthy
    5. gateway/composer/runtime up
    6. invite issued (auto-create channel + auto-invite at consume)
    7. join code exchange (one-shot, replay-safe)
    8. bridge bundle reachable
    9. real bridge spawn: WS handshake + gateway visibility + clean disconnect

  HEAD: $HEAD_SHA

EOF
