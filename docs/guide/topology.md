# Who runs what

Nexus is **not** federated — there is exactly **one** Nexus instance per
team, because Rocket.Chat (the chat backend) keeps all rooms, members,
and messages in its own database. Developers do **not** each install
Nexus full-stack; they only run the bridge.

## Per-component breakdown

| Component                          | Who runs it          | Where it runs             |
|------------------------------------|----------------------|---------------------------|
| Rocket.Chat + Mongo                | host owner (once)    | Docker on the host        |
| Postgres + Redis + mem0-api        | host owner (once)    | Docker on the host        |
| gateway / composer / runtime       | host owner (once)    | Bun + tmux on the host    |
| **`nexus-bridge`**                 | **each developer**   | **their own laptop**      |
| CLI tool (claude / cursor / …)     | each developer       | their own laptop ($PATH)  |

Each developer needs only Bun + a bridge config file + a token (issued
by the host admin via `make create-bridge`). One command starts the
bridge and the bot joins the room.

## What "the host" can be

The host doesn't have to be a dedicated server. It just needs to be
reachable by every developer's bridge on the gateway port:

| Host option                          | How bridges reach it           | Good for                         |
|--------------------------------------|--------------------------------|----------------------------------|
| One team member's laptop, same LAN   | `ws://192.168.x.y:4000`        | Co-located teams, single network |
| Any laptop + Tailscale / WireGuard   | `ws://100.x.y.z:4000` (mesh)   | 2–10 remote devs                 |
| Homelab box, NAS, Raspberry Pi 5     | port forward + DDNS            | Permanent, low-cost              |
| VPS (Hetzner / Contabo / DigitalOcean)| `wss://nexus.example.com`     | Larger teams, prod-ish           |

Required outbound from each bridge: TCP to the gateway port (default
`4000`). Required for browsers: HTTP(S) to Rocket.Chat (default `3000`).
Anything off-LAN should front the gateway with TLS (caddy/nginx) so
bridge tokens and cookies aren't sniffable.

## Sizing guidance

| Team size | Recommended host           | Notes                                          |
|-----------|----------------------------|------------------------------------------------|
| 1 (solo)  | The same laptop            | bridge connects to `localhost:4000`            |
| 2–5       | One member's laptop / NAS  | Works fine; ensure the laptop stays awake      |
| 5–20      | Small VPS or homelab       | 4 GB RAM is enough; 8 GB is comfortable        |
| 20+       | Dedicated VPS + TLS proxy  | Tune Postgres connection pool; consider HA     |

## Production readiness

The compose file ships **dev defaults**. Before any non-LAN deployment:

1. Replace every secret in `.env` (`openssl rand -hex 24`).
2. Front the gateway with TLS — bridge tokens + cookies are not
   encrypted in dev.
3. Restrict Postgres / Redis to `127.0.0.1` or a private network.
4. Enable backups for the Postgres volume.

See [Production caveats](/guide/production-caveats) for the full
checklist.

## Next

- [Quick start](/guide/quick-start) — bring up your first instance.
- [Add an AI partner (bridge)](/guide/bridges) — onboard a developer.
