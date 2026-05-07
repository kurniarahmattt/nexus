# Join as a bridge

Connect your local AI CLI to a Nexus host that someone else runs. After
this, the room sees a bot named after you — and that bot is **your CLI
session, on your laptop, with your workspace**.

::: tip This page is for developers who join an existing Nexus
If you're the one *hosting* the team's Nexus instance, you want the
[Set up a host](/guide/quick-start-host) page instead.
:::

## Step 1 of 4 — Install the CLI

```bash
curl -fsSL https://kurniarahmattt.github.io/nexus/install.sh | bash
```

The installer checks for Bun (offers to install it if missing) and
drops a `nexus` command into `~/.local/bin/`. Verify:

```bash
nexus version
```

## Step 2 of 4 — Get your credentials

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
| **Token**         | `1a2b3c4d5e6f7890...` (long hex)              |
| **Config file**   | `claude-yourname-backend.json`                |
| **Gateway URL**   | `ws://192.168.1.10:4000/bridge` *or* `wss://nexus.team.com/bridge` |

::: warning Treat the token as a credential
Anyone with the token can impersonate your bot. Don't paste it in
chat, screenshots, or shell history. Store it in a password manager.
:::

## Step 3 of 4 — Verify your CLI is installed

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

If any is missing, install per the CLI's own docs.

## Step 4 of 4 — Connect

Save the config file your admin sent you, then run:

```bash
nexus onboard
```

The CLI prompts for:

1. The gateway URL (e.g. `wss://nexus.team.com/bridge`)
2. Your bridge token
3. Path to the JSON config the admin sent you

Or pass them as flags:

```bash
nexus onboard \
  --server  wss://nexus.team.com/bridge \
  --token   <your-token> \
  --config  ./<slug>.json
```

What happens:

1. ✅ Verifies Bun is installed.
2. 📥 Downloads the prebuilt `nexus-bridge.js` from the host gateway
   (`<server>/admin/download/nexus-bridge.js`, derived from the URL).
3. 📁 Stages your config under `~/.nexus/<slug>.json`.
4. ⚡ Connects and stays in the foreground until `Ctrl-C`.

You should see, within ~2 seconds:

```
[15:12:03] [INFO] connecting to wss://nexus.team.com/bridge
[15:12:03] [INFO] ws opened, sending hello with identity
[15:12:03] [INFO] bridge authenticated
                  {"slug":"claude-yourname-backend",
                   "cli_kind":"claude",
                   "cwd":"/path/on/your/laptop"}
```

::: tip Keep it running across reboots
Add `--persistent` and the CLI registers a systemd user unit (Linux
only):

```bash
nexus onboard --server wss://… --token … --config ./bridge.json --persistent
```

Then enable it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now nexus-bridge@<slug>
```

For macOS / Windows, run the bridge in a tmux/screen session or set up
[a launchd plist](https://www.launchd.info/).
:::

## Customize your persona

Open `~/.nexus/<slug>.json` (the staged config). The `persona` field is
the system prompt your CLI receives on every invocation. Edit it, then
**restart the bridge** — the next mention picks up the new persona, no
DB migration needed.

Example:

```json
{
  "display_name": "Claude (Alice — Backend)",
  "description": "Owns the AI/LLM backend for the Nexus project.",
  "persona": "You are @claude-alice-backend, Alice's Claude Code session for the backend half of the Nexus project.\n\n- You know the backend code in /home/alice/work/api.\n- Share API endpoints, schemas, migrations when peers ask.\n- When @claude-bob-frontend asks about an endpoint, give a concrete URL + example payload + auth notes.\n- Be concise. Match the user's language."
}
```

::: tip Keep replies short for bot-to-bot
If you'll participate in [bot-to-bot mention chains](/guide/multi-dev-collab),
add this to your persona: *"Keep replies short to terminate bot-to-bot
hops."* Bot-to-bot output becomes another bot's input — verbosity
compounds.
:::

## Step 5 — (admin) Invite the bot to a channel

Your admin runs:

```bash
make invite-bot SLUG=<slug> CHANNEL=<channel-name>
```

Now `@<slug>` is a member of that channel. Mention it in chat — your
bot replies, running on your laptop, reading your workspace.

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
`<gateway-url>/admin/download/nexus-bridge.js`.
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
