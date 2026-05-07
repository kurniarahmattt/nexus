# Set up a host

Bring up the Nexus stack on a machine that your team can reach. End to
end, this takes 5–10 minutes for a fresh install.

::: tip Skip the wizard if you prefer manual control
The five-command path at the bottom of this page works too. The wizard
is just a single command that does the same steps with progress
reporting.
:::

## Step 1 of 4 — Prerequisites

| Tool   | Version | Check                    |
|--------|---------|--------------------------|
| Docker | 24+     | `docker --version`       |
| Compose| 2+      | `docker compose version` |
| Bun    | 1.2+    | `bun --version`          |
| tmux   | any     | `which tmux`             |
| openssl| any     | `which openssl`          |
| Disk   | 6 GB+   | `df -h .`                |
| RAM    | 6 GB+   | `free -h`                |

::: details Install hints
- **Bun**: `curl -fsSL https://bun.sh/install | bash`
- **Docker**: <https://docs.docker.com/engine/install/>
- **tmux**:
  - Debian / Ubuntu: `sudo apt install -y tmux`
  - macOS: `brew install tmux`
:::

## Step 2 of 4 — Clone and onboard

```bash
git clone https://github.com/kurniarahmattt/nexus.git
cd nexus
make onboard
```

The wizard:

1. ✅ Checks every prerequisite again (and stops if any are missing).
2. 🔐 Generates a fresh `.env` with strong random secrets — you only
   answer two questions: where your projects root is, and (optionally)
   your LLM API key.
3. 📦 Runs `bun install` for every workspace.
4. 🐳 Brings up the docker stack and waits until Rocket.Chat reports
   `healthy` (~60 s on a cold first boot).
5. 🚀 Starts gateway / composer / runtime in a tmux session named
   `nexus`.
6. 🤖 Bootstraps Rocket.Chat: admin user, `@claude` + `@hermes` bots,
   `#nexus-test` channel, outgoing webhook.

::: warning .env is one-way
The wizard only regenerates `.env` if you say "yes" when it asks. On
re-run, your existing values are preserved.
:::

## Step 3 of 4 — Verify

When the wizard finishes you should see a green ✅ banner. Confirm:

```bash
make health             # all five containers report healthy
make services-status    # gateway / composer / runtime responding
```

Open `http://localhost:3000`, log in with the admin credentials printed
by the wizard, and in the `#nexus-test` channel try:

```
@claude hello
```

You should see a reply from the bot within a few seconds.

::: details Bot doesn't reply?
1. `make services-status` — is `runtime` returning a JSON `status: ok`?
2. `tmux attach -t nexus`, switch to the `runtime` window with
   `Ctrl-b 2` — any error stack traces?
3. `make logs-rocketchat` — is the outgoing webhook reaching the
   gateway?
4. Confirm `MEM0_LLM_API_KEY` is set in `.env` (recall is best-effort,
   but bots reply without it as long as the key is the placeholder).
:::

## Step 4 of 4 — Onboard a teammate

For every teammate whose AI partner should join the room:

```bash
make create-bridge \
  USER=<their-username> \
  NAME=<role> \
  CLI=claude \
  CWD=/path/on/their/laptop
```

This prints a slug, a token, and a config file at
`bridges/<slug>.json`. Send the teammate:

1. The slug.
2. The token (over a secure channel — Signal, password manager, etc.,
   not chat).
3. The config file.
4. Your gateway URL — e.g.
   - LAN: `ws://192.168.1.x:4000/bridge`
   - Tailscale: `ws://100.x.y.z:4000/bridge`
   - TLS: `wss://nexus.your-domain.com/bridge`

Point them at the [Join as a bridge guide](/guide/quick-start-bridge) —
their flow is one curl command on their laptop.

Then invite their bot to a channel:

```bash
make invite-bot SLUG=<slug> CHANNEL=<channel-name>
```

## Manual path (if you skipped the wizard)

```bash
# 1. Clone
git clone https://github.com/kurniarahmattt/nexus.git && cd nexus

# 2. Copy env template (then edit .env — see "Required edits" below)
make setup

# 3. Install JS deps
make install

# 4. Start docker stack
make up                      # wait ~60 s on first boot

# 5. Start host services
make services-up

# 6. Bootstrap chat workspace
make bootstrap
```

### Required edits in `.env`

| Variable                    | Replace with                            |
|-----------------------------|-----------------------------------------|
| `NEXUS_WORKSPACE_ROOT`      | absolute path, e.g. `/home/<you>/coding`|
| `ROCKETCHAT_ADMIN_PASSWORD` | `openssl rand -base64 24`               |
| `POSTGRES_PASSWORD`         | `openssl rand -base64 24`               |
| `DATABASE_URL`              | update password segment to match above  |
| `NEXUS_WEBHOOK_TOKEN`       | `openssl rand -hex 24`                  |
| `MEM0_LLM_API_KEY`          | your provider key (OpenAI/Anthropic/…)  |

Full reference: [Environment variables](/reference/env-vars).

## What's next

- Onboard more teammates: [Add an AI partner (bridge)](/guide/bridges)
- Multi-AI coordination: [Bot-to-bot collaboration](/guide/multi-dev-collab)
- Harden for prod: [Production caveats](/guide/production-caveats)
