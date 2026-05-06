# Make targets

Run `make help` to see this list with one-line descriptions inline.

## Setup

| Target          | What it does                                                |
|-----------------|-------------------------------------------------------------|
| `make setup`    | Copies `.env.example` → `.env` if missing                   |
| `make install`  | `bun install` for all workspaces                            |

## Docker stack (infra)

| Target                | What it does                                                |
|-----------------------|-------------------------------------------------------------|
| `make up`             | `docker compose up -d`                                      |
| `make down`           | `docker compose down` (preserves volumes)                   |
| `make restart`        | `down` → `up`                                               |
| `make ps`             | Show running services                                       |
| `make health`         | Probe RC, Postgres, Redis, Mongo, Mem0 in one command       |
| `make logs`           | Tail all services                                           |
| `make logs-rocketchat`| Tail Rocket.Chat only                                       |
| `make logs-mem0`      | Tail mem0-api only                                          |
| `make psql`           | Open `psql` on the Nexus DB                                 |
| `make redis-cli`      | Open `redis-cli` on the Redis container                     |
| `make mongo-shell`    | Open `mongosh` on the Mongo container                       |

## Bootstrapping

| Target            | What it does                                                |
|-------------------|-------------------------------------------------------------|
| `make bootstrap`  | Create the admin user, `@claude` + `@hermes` bots, `#nexus-test` room |

## Host services (Bun + tmux)

| Target                | What it does                                                |
|-----------------------|-------------------------------------------------------------|
| `make services-up`    | Start gateway + composer + runtime in tmux session `nexus`  |
| `make services-down`  | Kill the tmux session                                       |
| `make services-attach`| Attach to the session (Ctrl-b d to detach)                  |
| `make services-status`| Probe each host service `/health`                           |
| `make dev-gateway`    | Run gateway in foreground (no tmux)                         |
| `make dev-composer`   | Run composer in foreground (no tmux)                        |
| `make dev-runtime`    | Run runtime in foreground (no tmux)                         |

## Web UI

| Target            | What it does                                                |
|-------------------|-------------------------------------------------------------|
| `make web-build`  | Build admin UI; gateway serves `/admin/*`                   |
| `make web-dev`    | Vite dev server (port 5173) with `/api` proxy to gateway    |

## Bridges (per-developer)

| Target                                       | What it does                                       |
|----------------------------------------------|----------------------------------------------------|
| `make create-bridge USER=<u> CWD=<path>`     | Provision a per-user bridge. Optional `NAME=<role>`, `CLI=<kind>`. Prints token + config path. |
| `make build-bridge`                          | Bundle `nexus-bridge.ts` to a single-file JS for distribution |
| `make invite-bot SLUG=<slug> CHANNEL=<name>` | Invite a bridge bot to a Rocket.Chat channel       |
| `make list-bridges`                          | Show every bridge + last-seen timestamp            |

## Cleanup

| Target            | What it does                                                |
|-------------------|-------------------------------------------------------------|
| `make clean`      | `down` + remove orphan containers (keeps volumes)           |
| `make nuke`       | **DESTRUCTIVE**. Drop containers AND volumes (data loss).   |

## Documentation

| Target            | What it does                                                |
|-------------------|-------------------------------------------------------------|
| `make docs-dev`   | VitePress dev server (port 5174)                            |
| `make docs-build` | Build the docs site to `docs/.vitepress/dist/`              |
| `make docs-preview`| Preview the production build locally                        |

## Type checking

| Target            | What it does                                                |
|-------------------|-------------------------------------------------------------|
| `make typecheck`  | `tsc --noEmit` across the monorepo                          |

## Format

| Target            | What it does                                                |
|-------------------|-------------------------------------------------------------|
| `make format`     | Run Prettier across `**/*.{ts,tsx,json,md}`                 |
