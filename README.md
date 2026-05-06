# N.E.X.U.S — Networked Ensemble for eXtensible User-agent Sessions

Self-hosted multi-user team chat with AI agent bots that wrap CLI tools
(Claude Code, Cursor Agent, Hermes, Gemini CLI). Each user can run their
own AI session on their PC and share it as a bot in team channels.

> **Status**: 9/10 phases done, working dev setup. Production deploy is
> still TODO. See [PLANNING.md](PLANNING.md) for the full architecture.
>
> **License**: Proprietary © SmartM2M Bandung (interim) — see [LICENSE](LICENSE).

## ⚠️ Security note for self-hosters

This repo ships **dev-only defaults** for passwords and secrets so the
stack runs out-of-the-box on a laptop:

```
ROCKETCHAT_ADMIN_PASSWORD=nexus_admin_dev
POSTGRES_PASSWORD=nexus_dev_pass
NEXUS_WEBHOOK_TOKEN=nexus_webhook_dev_secret
NEXUS_SESSION_SECRET=nexus_dev_session_secret_at_least_16
```

Before you put this on the open internet:

1. Copy `.env.example` → `.env` and **set every secret** to a long random
   value (`openssl rand -hex 24`).
2. Set `NEXUS_ADMIN_TOKEN` (admin login token for the Web UI).
3. Override the bot passwords (`RC_BOT_*_PASSWORD`).
4. Front the gateway with TLS (caddy / nginx) — bridge traffic + cookies
   are not encrypted in dev.

The compose file reads everything from `${VAR:-default}`, so `.env`
overrides apply to every service. Never commit `.env` (already gitignored).

## Dokumen

- [PLANNING.md](PLANNING.md) — dokumen planning lengkap (arsitektur, data model, milestone, ADR)

## Stack Singkat

- **Chat UI**: Rocket.Chat
- **Memory**: Mem0 + Postgres/pgvector + Redis (terisolasi, tidak pakai master memory existing)
- **Runtime**: Bun + TypeScript
- **Tool protocol**: MCP
- **Deploy dev**: Docker Compose di local PC (infra), Bun process di host (gateway/composer/runtime)
- **CLI agent v1**: `claude`, `hermes` (extend ke `cursor-agent`, `gemini` di Phase 5)

## Port Map (Dev)

| Service | Host port |
|---|---|
| Rocket.Chat | 3000 |
| MongoDB | 27017 |
| Postgres + pgvector | 5433 |
| Redis | 6380 |
| mem0-api | 4100 |
| nexus-gateway | 4000 |
| nexus-composer | 4001 |
| nexus-runtime | 4002 |

## Quick Start

Belum tersedia — repo masih di fase planning. Phase 0 (Foundation) akan menyediakan `make up` untuk spin stack.
