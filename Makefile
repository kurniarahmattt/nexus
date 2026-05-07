.PHONY: help setup up down restart logs ps health psql redis-cli mongo-shell \
        bootstrap dev-gateway dev-composer dev-runtime dev-services install \
        clean nuke

SHELL := /bin/bash
DC    := docker compose

# Auto-load .env if present so Makefile recipes see the same vars as docker-compose
ifneq (,$(wildcard .env))
  include .env
  export
endif

# ---- Defaults (override via .env) ----
POSTGRES_USER     ?= nexus
POSTGRES_DB       ?= nexus
ROCKETCHAT_URL    ?= http://localhost:3000

help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z0-9_-]+:.*?## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## First-time: copy .env.example to .env if missing
	@if [ ! -f .env ]; then cp .env.example .env && echo "Created .env from template. Review values before 'make up'."; else echo ".env already exists."; fi

onboard: ## One-shot interactive host setup (recommended for first-time users)
	@bash scripts/onboard.sh

install: ## Install JS dependencies for all workspaces
	bun install

up: ## Start all infra services (docker)
	$(DC) up -d
	@echo ""
	@echo "Stack starting. Check status: make ps / make health"
	@echo "Rocket.Chat boot takes ~60s on first start. Tail with: make logs-rocketchat"

down: ## Stop all services (preserve volumes)
	$(DC) down

restart: down up ## Restart everything

logs: ## Tail logs (all services)
	$(DC) logs -f --tail=100

logs-rocketchat: ## Tail Rocket.Chat logs
	$(DC) logs -f --tail=200 rocketchat

logs-mem0: ## Tail mem0-api logs
	$(DC) logs -f --tail=200 mem0-api

ps: ## Show service status
	$(DC) ps

health: ## Probe health endpoints for all services
	@echo "== Rocket.Chat =="
	@curl -sS -o /dev/null -w "  HTTP %{http_code}\n" $(ROCKETCHAT_URL)/api/info || echo "  FAIL"
	@echo "== Postgres =="
	@$(DC) exec -T postgres pg_isready -U $(POSTGRES_USER) -d $(POSTGRES_DB) 2>&1 | sed 's/^/  /' || echo "  FAIL"
	@echo "== Redis =="
	@$(DC) exec -T redis redis-cli ping 2>&1 | sed 's/^/  /' || echo "  FAIL"
	@echo "== Mongo =="
	@$(DC) exec -T mongo mongosh --quiet --eval 'rs.status().ok' 2>&1 | tail -1 | sed 's/^/  /' || echo "  FAIL"
	@echo "== Mem0 API =="
	@curl -sS -o /dev/null -w "  HTTP %{http_code}\n" http://localhost:4100/health || echo "  FAIL"

psql: ## Open psql shell on nexus database
	$(DC) exec -it postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

redis-cli: ## Open redis-cli on redis container
	$(DC) exec -it redis redis-cli

mongo-shell: ## Open mongosh on mongo container
	$(DC) exec -it mongo mongosh rocketchat

bootstrap: ## Create bot users (@claude, @hermes) + test room in Rocket.Chat
	@echo "Running Rocket.Chat bootstrap..."
	@bash scripts/bootstrap-rocketchat.sh

create-bridge: ## Provision a per-user bridge. USER=x CWD=/path [NAME=backend] [CLI=claude]
	@[ -n "$(USER)" ] || { echo "USER=<username> required"; exit 1; }
	@[ -n "$(CWD)" ]  || { echo "CWD=<abs-path> required"; exit 1; }
	@bash scripts/create-bridge.sh \
	  --user $(USER) \
	  --cli $(or $(CLI),claude) \
	  --cwd $(CWD) \
	  $(if $(NAME),--name $(NAME),)

invite-bot: ## Invite a bot to an RC channel. SLUG=<slug> CHANNEL=<name>
	@[ -n "$(SLUG)" ]    || { echo "SLUG=<slug> required"; exit 1; }
	@[ -n "$(CHANNEL)" ] || { echo "CHANNEL=<name> required"; exit 1; }
	@bash scripts/invite-bot.sh --slug $(SLUG) --channel $(CHANNEL)

issue-join-link: ## Issue a fresh one-shot join URL for an existing bridge. SLUG=<slug>
	@[ -n "$(SLUG)" ] || { echo "SLUG=<slug> required"; exit 1; }
	@SLUG=$(SLUG) bash scripts/issue-join-link.sh

issue-invite: ## Issue an invite that lets a developer create a new bridge themselves. USER=<username> [CLI=claude[,cursor,...]] [SLUG_PREFIX=...]
	@[ -n "$(USER)" ] || { echo "USER=<username> required"; exit 1; }
	@USER=$(USER) CLI=$(CLI) SLUG_PREFIX=$(SLUG_PREFIX) bash scripts/issue-invite.sh

list-bridges: ## Show all remote bridges + connection state
	@curl -sS http://localhost:4000/health | python3 -c "import json,sys; d=json.load(sys.stdin); \
	  print('Connected bridges:', len(d.get('bridges',[]))); \
	  [print(f\"  {b['slug']:30s} cli={b['cli']:8s} cwd={b['cwd']}\") for b in d.get('bridges',[])]"
	@echo ""
	@docker exec nexus-postgres psql -U nexus -d nexus -c "\
	  SELECT slug, display_name, kind, \
	         to_char(last_connected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS last_seen_utc \
	    FROM agents WHERE kind='remote' ORDER BY slug;"

# ---- Host-side dev services (Bun) ----
web-build: ## Build admin UI (services/web) → gateway serves /admin/*
	cd services/web && bun run build

build-bridge: ## Bundle nexus-bridge.ts to single-file JS for user distribution
	@mkdir -p packages/nexus-bridge/dist
	bun build packages/nexus-bridge/bin/nexus-bridge.ts \
	  --target=bun \
	  --outfile=packages/nexus-bridge/dist/nexus-bridge.js
	@echo "Bundle ready: packages/nexus-bridge/dist/nexus-bridge.js"
	@echo "Served at: http://localhost:4000/admin/download/nexus-bridge.js"

build-cli: ## Bundle the nexus CLI to a single Bun-runnable JS file
	@mkdir -p packages/nexus-cli/dist
	bun build packages/nexus-cli/bin/nexus.ts \
	  --target=bun \
	  --outfile=packages/nexus-cli/dist/nexus.js
	@echo "Bundle ready: packages/nexus-cli/dist/nexus.js"
	@echo "Served at: https://kurniarahmattt.github.io/nexus/nexus.js (after docs deploy)"

web-dev: ## Run Vite dev server (5173) with /api proxy to gateway
	cd services/web && bun run dev

docs-dev: ## Run VitePress dev server (5174) with HMR
	bun run docs:dev

docs-build: ## Build the docs site → docs/.vitepress/dist/
	bun run docs:build

docs-preview: ## Preview the production docs build locally
	bun run docs:preview

typecheck: ## Run tsc --noEmit across the monorepo
	bun run typecheck

format: ## Run Prettier across **/*.{ts,tsx,json,md}
	bun run format

dev-gateway: ## Run gateway service (host)
	cd services/gateway && bun --watch run src/index.ts

dev-composer: ## Run composer service (host)
	cd services/composer && bun --watch run src/index.ts

dev-runtime: ## Run runtime service (host)
	cd services/runtime && bun --watch run src/index.ts

TMUX_SESSION := nexus

services-up: ## Spawn gateway+composer+runtime in a tmux session (persists across Claude Code restarts)
	@command -v tmux >/dev/null 2>&1 || { echo "tmux required: apt install tmux"; exit 1; }
	@if tmux has-session -t $(TMUX_SESSION) 2>/dev/null; then \
	  echo "session $(TMUX_SESSION) already running. 'make services-attach' or 'make services-down' first."; \
	  exit 0; \
	fi
	@# Kill any stray Bash-tool background services first
	@pkill -f "bun services/(gateway|composer|runtime)/src/index.ts" 2>/dev/null || true
	@sleep 1
	tmux new-session -d -s $(TMUX_SESSION) -n gateway \
	  "cd $(PWD) && bun --watch services/gateway/src/index.ts"
	tmux new-window -t $(TMUX_SESSION) -n composer \
	  "cd $(PWD) && bun --watch services/composer/src/index.ts"
	tmux new-window -t $(TMUX_SESSION) -n runtime \
	  "cd $(PWD) && bun --watch services/runtime/src/index.ts"
	@sleep 2
	@echo ""
	@echo "✓ tmux session '$(TMUX_SESSION)' started with 3 windows (gateway/composer/runtime)."
	@echo "  Attach:  make services-attach  (detach: Ctrl-b d)"
	@echo "  Status:  make services-status"
	@echo "  Stop:    make services-down"

services-down: ## Kill the tmux session (services SIGTERM)
	@tmux kill-session -t $(TMUX_SESSION) 2>/dev/null && echo "session $(TMUX_SESSION) killed." || echo "no tmux session $(TMUX_SESSION)"

services-attach: ## Attach to the running tmux session (Ctrl-b d to detach)
	@tmux attach -t $(TMUX_SESSION)

services-status: ## Probe health of all host services + list tmux windows
	@echo "== tmux =="
	@tmux list-windows -t $(TMUX_SESSION) 2>/dev/null || echo "  (no session '$(TMUX_SESSION)')"
	@echo ""
	@echo "== health =="
	@for p in 4000 4001 4002 4100; do \
	  printf "  :%s " $$p; \
	  curl -sS --max-time 2 http://localhost:$$p/health 2>/dev/null | head -c 120 || echo "(no response)"; \
	  echo; \
	done

# ---- Cleanup ----
clean: ## Stop services and remove containers (keep volumes)
	$(DC) down --remove-orphans

nuke: ## DESTRUCTIVE: drop all containers AND volumes (data loss!)
	@read -p "This will DELETE all data (Mongo, Postgres, Redis, uploads). Type 'yes' to continue: " confirm && \
	  [ "$$confirm" = "yes" ] && $(DC) down -v --remove-orphans || echo "Aborted."
