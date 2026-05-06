# Per-User Bridges — Setup Guide

End-user guide for connecting a **local AI CLI session** (Claude Code, Hermes,
Cursor Agent, or Gemini CLI running on your own PC) into a Nexus channel
as a bot participant.

Nexus supports **multiple sessions per user**. Example layout for a project:

| Slug                          | CWD on user's PC         | Role                     |
|-------------------------------|--------------------------|--------------------------|
| `claude-rahmat-backend`       | `~/coding/nexus/backend` | Backend / LLM endpoint   |
| `claude-rahmat-infra`         | `~/coding/nexus/infra`   | Docker + deploy          |
| `claude-ilham-frontend`       | `~/coding/nexus/web`     | React UI + routing       |
| `cursor-ilham-e2e`            | `~/coding/nexus/e2e`     | Playwright tests         |

Each bridge has its own **token**, **persona/identity**, and **workspace**.

---

## 1. Admin provisions the bridge (on the Nexus server)

```bash
# slug = claude-rahmat-backend
make create-bridge \
  USER=rahmat \
  NAME=backend \
  CLI=claude \
  CWD=/home/rahmat/coding/nexus/backend
```

The command prints:

```
SLUG:    claude-rahmat-backend
BOT:     @claude-rahmat-backend  →  Claude (rahmat-backend)
SERVER:  ws://<lan-ip>:4000/bridge
TOKEN:   1a2b3c4d5e6f...
CWD:     /home/rahmat/coding/nexus/backend
CLI:     claude
CONFIG:  bridges/claude-rahmat-backend.json
```

What it does:

- Generates a one-time bridge **token**.
- Creates a Rocket.Chat bot user `@claude-rahmat-backend` with admin permissions inside rooms.
- Writes a **config template** to `bridges/<slug>.json` with default persona (EDIT IT).
- Adds `@<slug>` to the outgoing webhook `triggerWords`.

---

## 2. User edits the persona config

Open `bridges/<slug>.json`. Example:

```json
{
  "display_name": "Claude (Rahmat — Backend)",
  "description": "Owns the AI/LLM backend for the Nexus project; exposes endpoints to the team.",
  "persona": "You are @claude-rahmat-backend, Rahmat's Claude Code session for the backend half of the Nexus project.\n\nOperating rules:\n- You know the backend code in /home/rahmat/coding/nexus/backend.\n- Share API endpoints, schemas, migrations when peers ask.\n- When @claude-ilham-frontend asks about an endpoint, give a concrete URL + example payload + auth notes.\n- Be concise. Match the user's language.",
  "model": "sonnet-4-6",
  "cwd": "/home/rahmat/coding/nexus/backend"
}
```

Three fields drive identity:

- **display_name** — shown in RC member list and as the bot alias.
- **description** — one-liner for `make list-bridges` and future admin UI.
- **persona** — the full system prompt Claude (or whichever CLI) receives on every invocation. Gateway writes it to `agents.config.system_prompt` on every `hello`, so **restarting the bridge with a new persona propagates instantly**.

Optionally `persona_file: "./my-persona.md"` reads from a separate markdown file (useful for long personas).

---

## 3. User runs the bridge on their PC

Hand the user: (a) the token, (b) the config file, (c) the server URL.

```bash
# On Rahmat's PC
cd nexus/   # repo checkout
bun install

NEXUS_BRIDGE_TOKEN=1a2b3c4d5e6f... \
  bun packages/nexus-bridge/bin/nexus-bridge.ts \
    --config ./bridges/claude-rahmat-backend.json \
    --server ws://<nexus-host>:4000/bridge
```

Output:

```
[15:12:03] [INFO] connecting to ws://192.168.1.187:4000/bridge
[15:12:03] [INFO] ws opened, sending hello with identity
[15:12:03] [INFO] bridge authenticated {"slug":"claude-rahmat-backend","cli_kind":"claude","cwd":"/home/rahmat/coding/nexus/backend"}
```

The bridge **reconnects automatically** on network failure and re-sends the identity on every reconnect.

---

## 4. Invite the bot to a project channel

From the server side (or via RC admin UI):

```bash
make invite-bot SLUG=claude-rahmat-backend CHANNEL=project-nexus
```

Now `@claude-rahmat-backend` is a member of `#project-nexus` and responds whenever mentioned.

---

## 5. Verifying

```bash
# See all configured bridges + connection state.
make list-bridges
```

Expected output:

```
Connected bridges: 2
  claude-rahmat-backend          cli=claude   cwd=/home/rahmat/coding/nexus/backend
  claude-ilham-frontend          cli=claude   cwd=/home/ilham/coding/nexus/web

         slug                 |        display_name          |  kind  |     last_seen_utc
------------------------------+------------------------------+--------+---------------------
 claude-ilham-frontend        | Claude (Ilham — Frontend)    | remote | 2026-04-22 15:10:44
 claude-rahmat-backend        | Claude (Rahmat — Backend)    | remote | 2026-04-22 15:10:51
```

---

## 6. Updating persona later

1. Edit `bridges/<slug>.json` on the user's PC.
2. Restart `nexus-bridge` (`Ctrl+C` then rerun command).
3. Next `@mention` picks up the new persona — no DB migration needed.

---

## 7. Bot-to-bot conversation

Mention pattern `@<slug>` works from users AND bots. When
`@claude-rahmat-backend` mentions `@claude-ilham-frontend` in its reply,
Nexus automatically dispatches a new invocation to Ilham's bridge with a
hop counter. Max hop is 2 (configurable via `NEXUS_MAX_HOP`) so the chain
always terminates.

Personas should include "keep replies short to terminate bot-to-bot hops"
guidance if they're meant to participate in peer conversations.
