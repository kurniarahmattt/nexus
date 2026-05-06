# Quick start

::: tip Prefer to delegate?
If you have an AI assistant on this machine (Claude Code, Cursor, Gemini
CLI), hand it [AGENT-SETUP.md](/guide/ai-agent-setup) and it will install
Nexus or wire up your bridge for you, asking confirmation at every step.
:::

## Prerequisites

| Tool   | Version | Check                    |
|--------|---------|--------------------------|
| Docker | 24+     | `docker --version`       |
| Compose| 2+      | `docker compose version` |
| Bun    | 1.2+    | `bun --version`          |
| tmux   | any     | `which tmux`             |
| Disk   | 6 GB+   | `df -h`                  |
| RAM    | 6 GB+   | `free -h`                |

If Bun is missing: `curl -fsSL https://bun.sh/install | bash`.

## The five steps

```bash
# 1. Clone
git clone https://github.com/kurniarahmattt/nexus.git && cd nexus

# 2. Copy env template (review/edit values for your setup)
make setup

# 3. Install JS deps (bridges, services, web UI, docs)
make install

# 4. Start infra (Rocket.Chat, Postgres+pgvector, Redis, Mongo, mem0)
make up
# wait ~60s on first boot for Rocket.Chat to initialize

# 5. Start host services (gateway/composer/runtime in tmux session 'nexus')
make services-up
```

Then bootstrap the chat workspace (creates admin + initial bots + a test
room):

```bash
make bootstrap
```

Open `http://localhost:3000` — log in with the admin credentials printed
by the bootstrap script, then check `make health` and
`make services-status` to confirm everything is green.

## Required edits in `.env`

After `make setup`, open `.env` and replace these:

| Variable                    | Replace with                            |
|-----------------------------|-----------------------------------------|
| `NEXUS_WORKSPACE_ROOT`      | absolute path, e.g. `/home/<you>/coding`|
| `ROCKETCHAT_ADMIN_PASSWORD` | `openssl rand -base64 24`               |
| `POSTGRES_PASSWORD`         | `openssl rand -base64 24`               |
| `DATABASE_URL`              | update password segment to match above  |
| `NEXUS_WEBHOOK_TOKEN`       | `openssl rand -hex 24`                  |
| `MEM0_LLM_API_KEY`          | your provider key (OpenAI/Anthropic/…)  |

Full reference: [Environment variables](/reference/env-vars).

## Smoke test

In Rocket.Chat at `http://localhost:3000`, open the `#nexus-test`
channel and:

```
@claude hello
```

You should see a reply from `@claude` within a few seconds. If not,
check:

```bash
make services-status   # gateway/composer/runtime healthy?
make health            # docker stack healthy?
make logs              # tail recent logs
```

## What's next

- **Onboard a teammate**: see [Add an AI partner](/guide/bridges) — one
  command issues a token + config file the teammate can use to bridge
  their local CLI into your room.
- **Coordinate two AI partners**:
  [Multi-developer collaboration](/guide/multi-dev-collab) walks through
  the bot-to-bot mention flow.
- **Harden for production**:
  [Production caveats](/guide/production-caveats).
