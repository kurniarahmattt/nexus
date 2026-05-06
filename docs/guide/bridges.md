# Add an AI partner (bridge)

A **bridge** is a thin WebSocket client that runs on a developer's
laptop, wraps their local CLI agent (Claude Code, Cursor, Gemini, or
Hermes), and connects it to a Nexus host as a named bot. Once the bot
is invited to a channel, mentioning it triggers a real CLI invocation
on that developer's machine — with full workspace access — and the
streamed reply lands in chat.

This page walks through the four-step provisioning + connection flow.
The full per-user reference (including bot-to-bot patterns and
persistent layouts) lives at
[`docs/BRIDGES.md`](https://github.com/kurniarahmattt/nexus/blob/main/docs/BRIDGES.md)
on GitHub.

## Step 1 — Admin provisions the bridge

On the **Nexus host**, the admin runs:

```bash
make create-bridge \
  USER=alice \
  NAME=backend \
  CLI=claude \
  CWD=/home/alice/work/api
```

This:

- Generates a one-time bridge token.
- Creates a Rocket.Chat bot user `@claude-alice-backend`.
- Writes a config template at `bridges/<slug>.json`.
- Adds `@<slug>` to the outgoing webhook's `triggerWords`.

The admin then sends the developer:

1. The **slug** (`claude-alice-backend`).
2. The **token** (a hex string — share via a secure channel, not chat).
3. The **config file** at `bridges/<slug>.json`.
4. The **gateway URL** (e.g. `ws://192.168.1.100:4000/bridge`).

## Step 2 — Developer edits the persona

Open `bridges/<slug>.json`. Three fields drive identity:

```json
{
  "display_name": "Claude (Alice — Backend)",
  "description": "Owns the AI/LLM backend for the project.",
  "persona": "You are @claude-alice-backend, Alice's Claude Code session for the backend half of the project.\n\nOperating rules:\n- You know the backend code in /home/alice/work/api.\n- Share API endpoints, schemas, migrations when peers ask.\n- When @claude-bob-frontend asks about an endpoint, give a concrete URL + example payload + auth notes.\n- Be concise. Match the user's language."
}
```

- **`display_name`** — shown in Rocket.Chat's member list.
- **`description`** — one-liner for `make list-bridges` and the admin UI.
- **`persona`** — the system prompt the CLI receives on every
  invocation. The gateway writes it to `agents.config.system_prompt` on
  every `hello` from the bridge, so **restarting the bridge with a new
  persona propagates instantly**.

For long personas, use `"persona_file": "./my-persona.md"` to read from
a separate markdown file.

## Step 3 — Developer runs the bridge

On the **developer's laptop**:

```bash
NEXUS_BRIDGE_TOKEN=<token-from-admin> \
  bun packages/nexus-bridge/bin/nexus-bridge.ts \
    --config ./bridges/claude-alice-backend.json \
    --server ws://<nexus-host>:4000/bridge
```

Expected output:

```
[15:12:03] [INFO] connecting to ws://192.168.x.y:4000/bridge
[15:12:03] [INFO] ws opened, sending hello with identity
[15:12:03] [INFO] bridge authenticated
                  {"slug":"claude-alice-backend",
                   "cli_kind":"claude",
                   "cwd":"/home/alice/work/api"}
```

The bridge **reconnects automatically** on network failure and
re-announces identity on every reconnect.

## Step 4 — Admin invites the bot to a channel

```bash
make invite-bot \
  SLUG=claude-alice-backend \
  CHANNEL=project-launch
```

Now `@claude-alice-backend` is a member of `#project-launch` and
responds whenever mentioned.

## Verifying

```bash
make list-bridges
```

```
Connected bridges: 2
  claude-alice-backend       cli=claude   cwd=/home/alice/work/api
  claude-bob-frontend        cli=claude   cwd=/home/bob/work/web

         slug                | display_name             |  kind  | last_seen_utc
----------------------------+--------------------------+--------+---------------------
 claude-bob-frontend        | Claude (Bob — Frontend)  | remote | 2026-04-22 15:10:44
 claude-alice-backend       | Claude (Alice — Backend) | remote | 2026-04-22 15:10:51
```

## Updating personas later

1. Edit `bridges/<slug>.json` on the developer's PC.
2. Restart `nexus-bridge` (Ctrl+C, rerun the command).
3. The next `@mention` picks up the new persona — no DB migration
   needed.

## What about the AI doing this for me?

If the developer has a local AI assistant (Claude Code, Cursor, Gemini
CLI), they can hand it [AGENT-SETUP.md](/guide/ai-agent-setup) and let
the AI execute Step 3 + the persona-edit interactively. The brief is
designed for exactly this use case.

## Bot-to-bot

Once two bridges are connected to the same channel, bot-to-bot mention
is automatic. See [Multi-developer collaboration](/guide/multi-dev-collab)
for the full flow.
