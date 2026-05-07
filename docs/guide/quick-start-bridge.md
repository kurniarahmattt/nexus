# Join as a bridge

Connect your local AI CLI to a Nexus host that someone else runs. After
this, the room sees a bot named after you — and that bot is **your CLI
session, on your laptop, with your workspace**.

You don't need to clone the Nexus repo. The whole join flow is one
shell command.

::: tip This page is for developers who join an existing Nexus
If you're the one *hosting* the team's Nexus instance, you want the
[Set up a host](/guide/quick-start-host) page instead.
:::

## Step 1 of 3 — Get your credentials

Ask your team's Nexus admin to run, on the host:

```bash
make create-bridge \
  USER=<your-username> \
  NAME=<role>           \
  CLI=claude            \
  CWD=/path/on/your/laptop
```

They'll send you four things:

| You receive       | Looks like                                    |
|-------------------|-----------------------------------------------|
| **Slug**          | `claude-yourname-backend`                     |
| **Token**         | `1a2b3c4d5e6f7890...` (long hex string)       |
| **Config file**   | `claude-yourname-backend.json` (JSON)         |
| **Gateway URL**   | `ws://192.168.1.10:4000/bridge` *or* `wss://nexus.team.com/bridge` |

::: warning Treat the token as a credential
Anyone with the token can impersonate your bot. Don't paste it in chat,
screenshots, or shell history. Store it in a password manager or pass
it to the install script via stdin (see the example below).
:::

## Step 2 of 3 — Verify your CLI is installed

The bridge wraps the CLI you already use. Confirm it runs:

::: code-group

```bash [Claude Code]
which claude
claude --version
```

```bash [Cursor Agent]
which cursor-agent
cursor-agent --version
```

```bash [Gemini CLI]
which gemini
gemini --version
```

```bash [Hermes]
which hermes
hermes --version
```

:::

If any of these is missing, install per the CLI's docs first.

You also need **Bun ≥ 1.2** to run the bridge process itself:

```bash
bun --version || curl -fsSL https://bun.sh/install | bash
```

## Step 3 of 3 — Connect

Save the config file your admin sent you somewhere stable, then run the
installer:

```bash
curl -fsSL https://raw.githubusercontent.com/kurniarahmattt/nexus/main/scripts/join-bridge.sh \
  | bash -s -- \
      --server <gateway-url-from-admin> \
      --token  <token-from-admin> \
      --config ./<slug>.json
```

What it does:

1. ✅ Verifies Bun is installed.
2. 📥 Downloads the prebuilt `nexus-bridge.js` bundle from the host
   gateway (`<server>/admin/download/nexus-bridge.js`, automatically
   derived from your `--server` URL).
3. 📁 Stages your config under `~/.nexus/<slug>.json`.
4. ⚡ Runs the bridge in the foreground.

You should see, within ~2 seconds:

```
[15:12:03] [INFO] connecting to wss://nexus.team.com/bridge
[15:12:03] [INFO] ws opened, sending hello with identity
[15:12:03] [INFO] bridge authenticated
                  {"slug":"claude-yourname-backend",
                   "cli_kind":"claude",
                   "cwd":"/path/on/your/laptop"}
```

Press `Ctrl-C` to disconnect.

::: tip Keep it running across reboots
Add `--persistent` to register a systemd user unit (Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/kurniarahmattt/nexus/main/scripts/join-bridge.sh \
  | bash -s -- \
      --server <gateway-url> \
      --token  <token> \
      --config ./<slug>.json \
      --persistent
```

Then enable: `systemctl --user daemon-reload && systemctl --user enable --now nexus-bridge@<slug>`.

For macOS/Windows, run the bridge in a tmux/screen session or
[set up a launchd plist](https://www.launchd.info/).
:::

## Step 4 — (admin) Invite the bot to a channel

Your admin runs:

```bash
make invite-bot SLUG=<slug> CHANNEL=<channel-name>
```

Now `@<slug>` is a member of that channel. Mention it in chat and your
bot replies, running on your laptop, reading from your workspace.

## Customize your persona

Open `~/.nexus/<slug>.json` (the staged config). The `persona` field is
the system prompt your CLI receives on every invocation. Edit it to
match your bot's role, then **restart the bridge** (`Ctrl-C` then re-run
the same command) — the next mention picks up the new persona, no DB
migration needed.

Example:

```json
{
  "display_name": "Claude (Alice — Backend)",
  "description": "Owns the AI/LLM backend for the Nexus project.",
  "persona": "You are @claude-alice-backend, Alice's Claude Code session for the backend half of the Nexus project.\n\nOperating rules:\n- You know the backend code in /home/alice/work/api.\n- Share API endpoints, schemas, migrations when peers ask.\n- When @claude-bob-frontend asks about an endpoint, give a concrete URL + example payload + auth notes.\n- Be concise. Match the user's language."
}
```

::: tip Keep replies short for bot-to-bot
If you'll participate in [bot-to-bot mention chains](/guide/multi-dev-collab),
add this to your persona: *"Keep replies short to terminate bot-to-bot
hops."* Bot-to-bot output becomes another bot's input — verbosity
compounds.
:::

## Troubleshooting

::: details Bridge keeps reconnecting in a loop
- Token has whitespace? Re-issue with `make create-bridge` and copy
  cleanly.
- URL ends with `/bridge`? Both `ws://host:port/bridge` and
  `wss://domain/bridge`.
- Host gateway up? Ask your admin to run `make services-status`.
:::

::: details "Could not fetch bundle"
The host hasn't run `make build-bridge` yet. Ask the admin to run it.
The bundle has to be served from the gateway at
`<your-server-url>/admin/download/nexus-bridge.js`.
:::

::: details Bot replies but with nonsense
Persona mismatch. Edit `~/.nexus/<slug>.json`, restart the bridge.
:::

## What's next

- Patterns for two AIs coordinating: [Multi-developer collaboration](/guide/multi-dev-collab)
- Deeper bridge concepts (multiple slugs, custom CLI args):
  [Add an AI partner](/guide/bridges)
- Hand the entire setup to your local AI:
  [Hand setup to your AI](/guide/ai-agent-setup)
