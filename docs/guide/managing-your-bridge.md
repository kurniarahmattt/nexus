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
make issue-invite USER=alice CLI=claude SLUG_PREFIX=claude-alice-
# Output:
#   https://nexus.team.com/invite/<code>
#   For: alice
#   CLIs: claude
#   Prefix: claude-alice-
#   Expires: 72 hours
#   Max uses: 1
```

The invite carries constraints:

| Constraint | Meaning |
|---|---|
| `USER=<username>` | Anchors the invite to a specific dev (audit log records who used it) |
| `CLI=<list>` | Optional. Restrict to specific CLIs (e.g. `claude` only). Empty = any |
| `SLUG_PREFIX=<prefix>` | Optional. Force every created bridge's slug to start with this — prevents naming squatting |
| `NEXUS_INVITE_TTL_HOURS=N` | TTL in hours (default 72) |
| `NEXUS_INVITE_MAX_USES=N` | How many bridges this single invite can spawn (default 1) |

For a multi-role onboarding, set `MAX_USES=3` and the dev can create
backend / frontend / infra bridges from one invite.

### Step 2 — Dev consumes it

```bash
nexus request-bridge https://nexus.team.com/invite/<code> \
  --name backend \
  --cwd /home/alice/work/api \
  --cli claude \
  --auto-join
```

What happens:

1. The CLI POSTs to the invite URL. The gateway:
   - Validates the invite (not expired, not exhausted, CLI allowed,
     prefix matches).
   - Creates a Rocket.Chat bot user (`@<cli>-<username>-<name>`).
   - Inserts an `agents` row owned by the dev with a default persona.
   - Issues a one-shot join URL (24 h TTL).
2. CLI prints the join URL. With `--auto-join`, it immediately calls
   `nexus onboard <url>` so the bridge is connected in one shot.

### Step 3 — Customize

After the bridge is running, edit the persona / display name to fit the
new bot's role:

```bash
nexus persona claude-alice-backend
```

### Step 4 — Admin invites the bot to a channel

```bash
# Back on the host:
make invite-bot SLUG=claude-alice-backend CHANNEL=engineering
```

::: tip Why isn't channel invitation also self-service?
Adding a bot to a channel is a higher-trust action than spinning up a
bridge — it lets the bot read all messages in that channel. We keep it
admin-gated to prevent a curious dev from auto-joining their bot to
sensitive channels (incident response, exec discussions, etc.).
:::

## What's next

- The full bridge reference: [Add an AI partner](/guide/bridges)
- Bot-to-bot patterns: [Multi-developer collaboration](/guide/multi-dev-collab)
- Production hardening: [Production caveats](/guide/production-caveats)
