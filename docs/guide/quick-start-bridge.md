# Join as a bridge

Connect your local AI CLI to a Nexus host that someone else runs. After
this, the room sees a bot named after you — and that bot is **your CLI
session, on your laptop, with your workspace**.

::: tip This page is for developers who join an existing Nexus
If you're the one *hosting* the team's Nexus instance, you want the
[Set up a host](/guide/quick-start-host) page instead.
:::

## Step 1 of 3 — Install the CLI

```bash
curl -fsSL https://kurniarahmattt.github.io/nexus/install.sh | bash
```

The installer checks for Bun (offers to install it if missing) and
drops a `nexus` command into `~/.local/bin/`. Verify:

```bash
nexus version
```

## Step 2 of 3 — Get a URL from your admin

Your admin will send you **one** URL. There are two flavors:

| URL pattern | Meaning |
|---|---|
| `…/join/<code>`  | Admin already provisioned the bridge for you. Just connect. |
| `…/invite/<code>` | Admin gave you an invite to *create your own* bridge — you pick the role / CWD / CLI within constraints. |

Both work with the same `nexus onboard` command (CLI auto-detects).

Admin issues a join URL via:

```bash
make create-bridge USER=<you> NAME=<role> CLI=claude CWD=/path/on/your/laptop
# → https://nexus.team.com/join/aB3xK9PpZ4...
```

Or an invite URL (when admin wants the dev to pick role/CWD themselves):

```bash
make issue-invite USER=<you> CLI=claude SLUG_PREFIX=claude-<you>- \
  CHANNELS=engineering,team-<you>
# → https://nexus.team.com/invite/aBC123...
```

::: warning Treat the join URL as a credential
The URL is **one-shot** (consumed on first use) and **time-bounded**
(expires in 24 h by default), but if it leaks before you use it,
someone else could claim your bot identity. Send via Signal, password
manager, or encrypted email — not in public chat.
:::

::: details What if my admin still uses the legacy 4-fields handoff?
If you got a slug + token + config file + gateway URL instead, see
[Legacy onboarding](#legacy-onboarding) at the bottom of this page.
:::

## Step 3 of 3 — Connect

Make sure the CLI you'll bridge is installed:

::: code-group

```bash [Claude Code]
which claude && claude --version
```

```bash [Cursor Agent]
which cursor-agent && cursor-agent --version
```

```bash [Gemini CLI]
which gemini && gemini --version
```

```bash [Hermes]
which hermes && hermes --version
```

:::

Then:

```bash
nexus onboard https://nexus.team.com/join/aB3xK9PpZ4...
```

The CLI:

1. ✅ Verifies Bun is installed.
2. 📥 Refuses plain `http://` URLs (use `--allow-insecure` for LAN-only).
3. 🔁 POSTs to the URL → server consumes the code, returns slug,
   gateway WebSocket URL, bridge token, and persona config in one shot.
4. 📁 Stages the config under `~/.nexus/<slug>.json`.
5. 📦 Downloads `nexus-bridge.js` from the host.
6. ⚡ Connects and stays in the foreground until `Ctrl-C`.

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
nexus onboard https://nexus.team.com/join/<code> --persistent
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

## Legacy onboarding

If you got 4 separate items from your admin instead of one URL (older
hosts that haven't upgraded yet):

```bash
nexus onboard \
  --server  wss://nexus.team.com/bridge \
  --token   <your-token> \
  --config  ./<slug>.json
```

Or interactively:

```bash
nexus onboard
# (it will ask you whether you have a join URL; say "no" and it falls
# back to the legacy 3-prompt flow)
```

This works exactly the same as the URL flow once the credentials are
collected.

## What's next

- Patterns for two AIs coordinating: [Multi-developer collaboration](/guide/multi-dev-collab)
- Deeper bridge concepts (multiple slugs, custom CLI args):
  [Add an AI partner](/guide/bridges)
- Hand the entire setup to your local AI:
  [Hand setup to your AI](/guide/ai-agent-setup)
