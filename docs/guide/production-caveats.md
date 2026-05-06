# Production caveats

Nexus is **dev-ready, not yet production-hardened**. The repo ships
dev-only defaults so the stack runs out-of-the-box on a laptop. Before
exposing it beyond a trusted LAN, work through this checklist.

## Replace every default secret

The compose file resolves `${VAR:-default}` for everything, so a real
`.env` overrides every service. Replace the dev defaults:

```bash
# Generate fresh values:
openssl rand -hex 24                # for token-style secrets
openssl rand -base64 24             # for password-style secrets
```

Variables that **must** be replaced before deploy:

| Variable                    | Purpose                                  |
|-----------------------------|------------------------------------------|
| `ROCKETCHAT_ADMIN_PASSWORD` | RC admin login                           |
| `POSTGRES_PASSWORD`         | DB superuser                             |
| `DATABASE_URL`              | Update password segment to match above   |
| `NEXUS_WEBHOOK_TOKEN`       | RC → gateway webhook auth                |
| `NEXUS_SESSION_SECRET`      | Session cookies for the admin Web UI     |
| `NEXUS_ADMIN_TOKEN`         | Admin login token (Web UI)               |
| `MEM0_LLM_API_KEY`          | Real provider key (OpenAI/Anthropic/…)   |
| Each `RC_BOT_*_PASSWORD`    | Per-bot passwords                        |

`.env` is gitignored — keep it that way.

## Front the gateway with TLS

Bridge tokens travel over the gateway WebSocket. Without TLS, anyone on
the network path can sniff them and impersonate a bot.

Caddy is the simplest reverse proxy. Save this as `Caddyfile`:

```text
nexus.example.com {
    reverse_proxy /bridge   localhost:4000
    reverse_proxy /api/*    localhost:4000
    reverse_proxy /admin/*  localhost:4000
    reverse_proxy /         localhost:3000
}
```

Bridges then connect to `wss://nexus.example.com/bridge`.

## Restrict Postgres / Redis exposure

The dev compose binds Postgres to `0.0.0.0:5433` and Redis to
`0.0.0.0:6380`. For production, bind to `127.0.0.1` only:

```yaml
postgres:
  ports:
    - "127.0.0.1:5433:5432"

redis:
  ports:
    - "127.0.0.1:6380:6379"
```

Or remove the host port mapping entirely if every consumer runs in the
same compose network.

## Back up the Postgres volume

Memory, summaries, landmarks, audit logs, and bot configs all live in
Postgres. Back the volume up regularly:

```bash
# nightly cron
docker exec nexus-postgres pg_dump -U nexus nexus \
  | gzip > /backup/nexus-$(date +%F).sql.gz
```

Mongo (Rocket.Chat's data) also benefits from backups for chat history.

## Rotate bot credentials when devs leave

When a teammate leaves, the host admin should:

1. Stop their bridge (it'll fail next reconnect anyway).
2. Disable or remove the bot user in Rocket.Chat:
   `make disable-bridge SLUG=<slug>` (planned) or via the admin Web UI.
3. Revoke the bridge token by clearing `agents.config.bridge.token` in
   Postgres.

## Audit log review

Phase 7 introduces an audit log table that records every invoke +
tool_call. For production, schedule a periodic review (or hook it into
your existing SIEM):

```sql
SELECT event_type, count(*)
FROM audit_log
WHERE ts > now() - interval '24 hours'
GROUP BY event_type
ORDER BY 2 DESC;
```

## Rate limits

The gateway has per-user, per-room rate limits in Phase 1+ but the
defaults are conservative. For multi-team deploys, raise them in
`services/gateway/src/env.ts` (TODO: env-driven knobs).

## Reporting issues

Found a hardening gap? Please file it via
[GitHub Security Advisories](https://github.com/kurniarahmattt/nexus/security/advisories/new),
not as a public issue. See
[SECURITY.md](https://github.com/kurniarahmattt/nexus/blob/main/SECURITY.md).
