# Set up a host

Bring up the Nexus stack on a machine that your team can reach. End to
end, this takes 5–10 minutes for a fresh install.

## Step 1 of 3 — Install the CLI

```bash
curl -fsSL https://kurniarahmattt.github.io/nexus/install.sh | bash
```

This drops a `nexus` command into `~/.local/bin/`. The installer checks
for Bun and offers to install it if missing.

::: details PATH not set?
If `~/.local/bin` isn't already on your `$PATH`, the installer prints
the line to add to your shell rc. Add it, restart the shell, then
verify:

```bash
nexus version
```
:::

## Step 2 of 3 — Run the host wizard

```bash
nexus host-onboard
```

If you haven't cloned the Nexus repo yet, the wizard will ask where to
install it (default: `~/coding/nexus`) and clone it for you. Then it
runs an interactive 6-step setup:

1. ✅ Prerequisites check (Docker, Bun, tmux, openssl, git, disk, RAM)
2. 🔐 `.env` generation — workspace root prompt + auto-generated strong
   secrets (`openssl rand`) for every credential. You only answer two
   questions: your projects root and (optionally) your LLM API key.
3. 📦 `bun install` for every workspace.
4. 🐳 Docker stack up; waits until Rocket.Chat reports `healthy` (~60 s
   on a cold first boot).
5. 🚀 Host services start in a tmux session named `nexus`.
6. 🤖 Rocket.Chat bootstrap: admin user, `@claude` + `@hermes` bots,
   `#nexus-test` channel, outgoing webhook.

::: warning .env is one-way
The wizard only regenerates `.env` if you say "yes" when it asks.
Re-running preserves your existing values.
:::

## Step 3 of 3 — Verify

When the wizard finishes you'll see a green ✅ banner. Confirm:

```bash
make health             # all five containers healthy
make services-status    # gateway / composer / runtime responding
```

Open `http://localhost:3000`, log in with the admin credentials printed
by the wizard, and in the `#nexus-test` channel try:

```
@claude hello
```

Bot should reply within a few seconds.

::: details Bot doesn't reply?
1. `make services-status` — is `runtime` returning `status: ok`?
2. `tmux attach -t nexus`, switch with `Ctrl-b 2` to the runtime
   window — any error stack traces?
3. `make logs-rocketchat` — is the outgoing webhook reaching the
   gateway?
4. Confirm `MEM0_LLM_API_KEY` is set (recall is best-effort but bots
   still reply if it's the placeholder).
:::

## Onboarding teammates

For every teammate whose AI partner should join the room:

```bash
make create-bridge \
  USER=<their-username> \
  NAME=<role> \
  CLI=claude \
  CWD=/path/on/their/laptop
```

Send them four things over a secure channel (not chat):

1. **Slug** (`claude-alice-backend`)
2. **Token** (the long hex string)
3. **Config file** (`bridges/<slug>.json`)
4. **Gateway URL** — `ws://<your-LAN-IP>:4000/bridge`,
   `ws://<tailscale-ip>:4000/bridge`, or `wss://<your-domain>/bridge`

Point them at the [Join as a bridge guide](/guide/quick-start-bridge) —
their flow is one CLI command.

Then invite their bot to a channel:

```bash
make invite-bot SLUG=<slug> CHANNEL=<channel-name>
```

## Manual path (without the CLI)

You can do everything by hand. Inside the Nexus checkout:

```bash
make setup       # copy .env.example to .env (edit first!)
make install     # bun install across workspaces
make up          # docker stack
make services-up # gateway/composer/runtime in tmux
make bootstrap   # admin user + bots + test channel
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
