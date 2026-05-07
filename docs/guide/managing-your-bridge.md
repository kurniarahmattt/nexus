# Managing your bridge

Once your bridge is connected (you've followed
[Join as a bridge](/guide/quick-start-bridge)), you'll often want to
tweak how your bot behaves. This page covers the three most common
tasks:

1. **Update the persona** (system prompt) — change how the bot speaks
   and what it's responsible for.
2. **Rename the bot** — change the display name visible in chat.
3. **Add a new bridge** — create a second bot for a different role
   (e.g. one for backend, one for infra) using an admin invite.

::: tip Where the source of truth lives
For per-bridge fields (persona, display name, description, model), the
**bridge config on your laptop** (`~/.nexus/<slug>.json`) is the source
of truth. The gateway updates `agents.config` from your bridge's
`hello` frame on every connect — so editing the file and restarting
the bridge is the canonical workflow.
:::

## Update the persona

The persona is the system prompt your CLI receives on every invocation.
It defines voice, scope, peer relationships, and edge-case behavior.

### Quick edit

```bash
nexus persona <slug>
```

Interactive: shows current values, lets you pick a field, opens the
persona in your `$EDITOR` (or prompts inline for short fields), saves,
and offers to restart the bridge.

### Show current values

```bash
nexus persona <slug> --show
```

### Open the whole config in `$EDITOR`

```bash
nexus persona <slug> --edit
```

### Non-interactive (scripts / automation)

```bash
nexus persona <slug> --field persona --value "$(cat new-persona.md)"
nexus persona <slug> --field description --value "Backend specialist for the order service"
```

### What happens server-side

When you save the file, the values are local until the bridge sends the
next `hello` frame. The CLI offers to restart the bridge for you
(via systemd if you onboarded with `--persistent`). On reconnect:

1. The gateway reads `persona`, `description`, and `model` from the
   `hello` frame and writes them to `agents.config` in Postgres.
2. Subsequent `@<slug>` mentions use the new persona immediately.
3. No DB migration, no admin involvement.

::: warning No history rollback
The previous persona is overwritten. Keep your own backup if you want
to revert. Tip: keep the persona text in a separate file (e.g.
`~/.nexus/persona-<slug>.md`) and reference it from the JSON config so
your version-controlled file is the source of truth.
:::

## Rename the bot (display name)

The display name is what teammates see in chat — in the member list,
mentions autocomplete, and message-author labels. It's stored both in
Nexus's `agents.display_name` AND in the bot's Rocket.Chat user
profile, so updates need to propagate to both.

### Quick

```bash
nexus persona <slug> --field display_name --value "Alice's API specialist"
```

### What happens server-side

On the next `hello` frame:

1. Gateway sees the new `display_name` differs from the DB row.
2. Updates `agents.display_name`.
3. Calls Rocket.Chat's `users.updateOwnBasicInfo` API as the bot,
   updating the bot's chat profile.
4. New name appears in chat (you may need to refresh the channel to
   see it).

::: details The `@<slug>` mention itself doesn't change
The Rocket.Chat **username** is the slug (set at create-bridge time)
and isn't updated by `display_name` changes. Mentioning `@<slug>` still
works as before. To change the slug, you'd have to delete the bot and
re-issue from scratch.
:::

::: tip Coordinating with teammates
A display-name change is silent — your peers won't get a notification.
If the change is significant (e.g. you're handing the bridge over to
someone else), drop a heads-up in the channel.
:::

## Request a new bridge (e.g. one bot per project area)

You may want multiple bridges for different roles — one for backend,
one for infra, etc. Each bridge has its own persona, slug, and (often)
its own working directory.

The host admin gives you an **invite URL**, then you spin up bridges
yourself — no per-bridge admin involvement.

### Step 1 — Admin issues an invite

```bash
# On the host:
make issue-invite USER=alice CLI=claude \
  SLUG_PREFIX=claude-alice- \
  CHANNELS=engineering,team-alice
```

Output:

```
  https://nexus.team.com/invite/<code>

  For:        alice
  CLIs:       claude
  Prefix:     claude-alice-
  Channels:   engineering,team-alice
  Expires:    72 hours from now
  Max uses:   1
```

The invite carries constraints:

| Constraint | Meaning |
|---|---|
| `USER=<username>` | Anchors the invite to a specific dev (audit log records who used it) |
| `CLI=<list>` | Optional. Restrict to specific CLIs (e.g. `claude` only). Empty = any |
| `SLUG_PREFIX=<prefix>` | Optional. Force every created bridge's slug to start with this — prevents naming squatting |
| `CHANNELS=<list>` | Optional. Auto-invite the new bot to these RC channels on creation. Comma-separated, no `#`. Pre-approved list — admin decides which channels are safe |
| `NEXUS_INVITE_TTL_HOURS=N` | TTL in hours (default 72) |
| `NEXUS_INVITE_MAX_USES=N` | How many bridges this single invite can spawn (default 1) |

For a multi-role onboarding, set `MAX_USES=3` and the dev can create
backend / frontend / infra bridges from one invite — all auto-joining
the channels the admin pre-approved.

### Step 2 — Dev consumes it (one command, full setup)

```bash
nexus onboard https://nexus.team.com/invite/<code>
```

That's it. The CLI walks you through the full bot setup interactively
in four short stages, then connects:

#### Stage 1 — basic identity

The CLI prompts for:

- **Role / suffix** (e.g. `backend`) — becomes part of the slug
- **Absolute path** to your project on this laptop (the `cwd` the bot
  will read/write in)
- **CLI** to wrap (`claude` / `cursor` / `gemini` / `hermes`)
- **Your username** (defaults to `$USER`)

Then it verifies the wrapped CLI binary is installed (`which claude`
etc.) — if missing, prints an install hint and asks whether to
proceed anyway.

#### Stage 2 — chat appearance

- **Display name** — shown in member list and message author. Default
  is auto-generated from slug (you can press Enter to accept).
- **Description** — one-liner shown in admin listings (optional, can
  be empty).

#### Stage 3 — persona (system prompt)

The CLI offers to open `$EDITOR` with a pre-filled persona template
(slug, owner, cli, cwd already plugged in; "Operating rules" /
"Scope" / "Voice" sections to customize). Save and quit to apply.

::: tip Skip if you want defaults for now
Answer "no" to the customize prompt and a generic persona is used.
You can edit later anytime with `nexus persona <slug>`.
:::

#### Stage 4 — persistence (Linux only)

Asks whether to register a systemd user unit so the bridge auto-starts
on boot and reconnects after crashes. `nexus onboard` writes the unit
file; you'll see the `systemctl --user enable --now …` command at the
end.

#### Then the CLI submits

POSTs to the gateway with everything you provided. The gateway:

- Validates the invite (expiry, uses_count, CLI allowlist, prefix)
- Creates the Rocket.Chat bot user with your display name + persona
- Inserts an `agents` row owned by your user
- **Auto-invites the bot to every channel in `default_channels`**
- Issues a one-shot join URL (24 h TTL)

Then auto-chains into `nexus onboard <join-url>`: bundle download →
bridge connect → `bridge authenticated` log.

::: details Want non-interactive? Use the underlying `request-bridge` directly.
```bash
nexus request-bridge https://nexus.team.com/invite/<code> \
  --name backend \
  --cwd /home/alice/work/api \
  --cli claude \
  --auto-join
```
This is the same flow `nexus onboard <invite-url>` runs, just with
flags instead of prompts. Useful for shell scripts or CI.
:::

### Step 3 — Customize later (anytime)

Whatever you set during onboard isn't permanent — change anything later
without a restart-from-scratch:

```bash
nexus persona claude-alice-backend                     # interactive picker
nexus persona claude-alice-backend --field display_name --value "..."
nexus persona claude-alice-backend --edit              # opens \$EDITOR
```

Saves to `~/.nexus/<slug>.json` on your laptop, then offers to restart
the bridge so the new identity propagates to the host.

### Channel scope: who decides what

| Action | Who |
|---|---|
| Bot exists at all | Admin (issues the invite + sets `CHANNELS=`) |
| Bot is a member of a channel | Admin (via `CHANNELS=` in invite, or `make invite-bot` later) |
| Bot's persona / name | Dev (via `nexus persona`) |
| Bot's CWD on this laptop | Dev (set at request-bridge time) |

::: tip Why is channel pre-approval an admin call?
Adding a bot to a channel lets it read every message in that channel.
That's a real privacy boundary — the dev's CLI on their laptop will
see those messages once the bot is mentioned (or even just listening
for context if so configured). The admin pre-approves a safe set when
issuing the invite; anything else needs an explicit
`make invite-bot SLUG=… CHANNEL=…` call later.
:::

## What's next

- The full bridge reference: [Add an AI partner](/guide/bridges)
- Bot-to-bot patterns: [Multi-developer collaboration](/guide/multi-dev-collab)
- Production hardening: [Production caveats](/guide/production-caveats)
