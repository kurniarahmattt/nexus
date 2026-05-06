# Environment variables

All configuration lives in `.env` (copied from `.env.example` via
`make setup`). Every Docker service and host process reads from this
file.

## Required (set before `make up`)

| Variable                    | Purpose                                                  |
|-----------------------------|----------------------------------------------------------|
| `NEXUS_WORKSPACE_ROOT`      | Absolute path to the parent dir of project workspaces. Composer fails fast if unset. |
| `ROCKETCHAT_ADMIN_PASSWORD` | RC admin login. **Replace** the dev default.             |
| `POSTGRES_PASSWORD`         | Postgres superuser. **Replace** the dev default.         |
| `DATABASE_URL`              | Full connection URL — must include the password above.   |
| `NEXUS_WEBHOOK_TOKEN`       | RC → gateway webhook auth. **Replace** before any non-LAN deploy. |

## Rocket.Chat

| Variable                     | Default                  | Purpose                          |
|------------------------------|--------------------------|----------------------------------|
| `ROCKETCHAT_URL`             | `http://localhost:3000`  | Public URL of the chat instance  |
| `ROCKETCHAT_ADMIN_USERNAME`  | `admin`                  | Admin login                      |
| `ROCKETCHAT_ADMIN_PASSWORD`  | `nexus_admin_dev`        | Admin password                   |
| `ROCKETCHAT_ADMIN_EMAIL`     | `admin@nexus.local`      | Admin email (verification stub)  |

## Postgres + pgvector

| Variable           | Default                                                 |
|--------------------|---------------------------------------------------------|
| `POSTGRES_HOST`    | `localhost`                                             |
| `POSTGRES_PORT`    | `5433`                                                  |
| `POSTGRES_USER`    | `nexus`                                                 |
| `POSTGRES_PASSWORD`| `nexus_dev_pass`                                        |
| `POSTGRES_DB`      | `nexus`                                                 |
| `DATABASE_URL`     | `postgresql://nexus:nexus_dev_pass@localhost:5433/nexus`|

## Redis

| Variable      | Default                  |
|---------------|--------------------------|
| `REDIS_HOST`  | `localhost`              |
| `REDIS_PORT`  | `6380`                   |
| `REDIS_URL`   | `redis://localhost:6380` |

## Nexus services (host)

| Variable        | Default | Purpose                              |
|-----------------|---------|--------------------------------------|
| `GATEWAY_PORT`  | `4000`  | gateway listens here                 |
| `COMPOSER_PORT` | `4001`  | composer health/admin endpoints      |
| `RUNTIME_PORT`  | `4002`  | runtime health endpoint              |
| `MEM0_API_URL`  | `http://localhost:4100` | composer talks to mem0 here |

## Mem0 (memory layer)

Mem0 needs an LLM for fact extraction + summarization. Use any
OpenAI-compatible endpoint.

| Variable                | Default                         |
|-------------------------|---------------------------------|
| `MEM0_LLM_PROVIDER`     | `openai`                        |
| `MEM0_LLM_MODEL`        | `gpt-4o-mini`                   |
| `MEM0_LLM_BASE_URL`     | `https://api.openai.com/v1`     |
| `MEM0_LLM_API_KEY`      | `sk-replace-me` — **set this**  |
| `MEM0_EMBEDDER_PROVIDER`| `huggingface` (local)           |
| `MEM0_EMBEDDER_MODEL`   | `sentence-transformers/all-MiniLM-L6-v2` |
| `MEM0_EMBEDDING_DIMS`   | `384`                           |

For a self-hosted vLLM:

```bash
MEM0_LLM_BASE_URL=http://localhost:8000/v1
MEM0_LLM_MODEL=<your-model-id>
MEM0_LLM_API_KEY=any-string-vllm-ignores-it
```

## CLI binaries

The runtime resolves each CLI by `$PATH` by default. Override only when
the binary lives somewhere unusual.

| Variable      | Default                | Used by                      |
|---------------|------------------------|------------------------------|
| `CLAUDE_BIN`  | `claude` (via PATH)    | `runtime/adapters/claude.ts` |
| `HERMES_BIN`  | `hermes` (via PATH)    | `runtime/adapters/hermes.ts` |
| `CURSOR_BIN`  | `agent` (via PATH)     | `runtime/adapters/cursor.ts` |
| `GEMINI_BIN`  | `gemini` (via PATH)    | `runtime/adapters/gemini.ts` |
| `GEMINI_MODEL`| `gemini-2.5-flash`     | `runtime/adapters/gemini.ts` |

## Compaction tuning (composer)

| Variable                  | Default | Purpose                                      |
|---------------------------|---------|----------------------------------------------|
| `NEXUS_TRANSCRIPT_WINDOW` | `20`    | Raw messages kept verbatim per invocation    |
| `NEXUS_OLDER_WINDOW`      | `100`   | Older messages summarized behind the window  |
| `NEXUS_LANDMARK_WINDOW`   | `10`    | Landmark candidates scanned in visible range |

## Bot-to-bot

| Variable          | Default | Purpose                                        |
|-------------------|---------|------------------------------------------------|
| `NEXUS_MAX_HOP`   | `2`     | Max bot-to-bot mention dispatches per chain    |

## Logging

| Variable      | Default       | Notes                              |
|---------------|---------------|------------------------------------|
| `LOG_LEVEL`   | `info`        | `trace`/`debug`/`info`/`warn`/`error` |
| `NODE_ENV`    | `development` | Enables `pino-pretty` in dev       |

## Optional fallback keys

If you want to use a real provider directly (without the Mem0 layer
proxying):

| Variable             | Notes                            |
|----------------------|----------------------------------|
| `ANTHROPIC_API_KEY`  | Unused if `MEM0_LLM_*` is set    |
| `OPENAI_API_KEY`     | Unused if `MEM0_LLM_*` is set    |
