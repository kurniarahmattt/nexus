# Hand setup to your AI

Nexus ships a structured prompt designed to be handed to an AI assistant
(Claude Code, Cursor Agent, Gemini CLI, Hermes — anything with file +
shell access). The agent reads the brief, asks a couple of clarifying
questions, and runs the install for you while asking permission at each
destructive step.

::: tip Why this exists
Setting up Nexus the first time involves Docker, Bun, tmux, an `.env`
file, secrets generation, two flavors of bring-up (host vs bridge), and
a smoke test. That's a lot of context for a human to internalize on
day 0. AI agents are very good at executing this kind of well-scoped
sequence — let them.
:::

## How to use it

The brief lives at
[`docs/AGENT-SETUP.md`](https://github.com/kurniarahmattt/nexus/blob/main/docs/AGENT-SETUP.md)
in the repo. There are several ways to hand it to your AI:

### Option 1 — point your AI at the file in your local checkout

```bash
# inside your nexus checkout:
claude < docs/AGENT-SETUP.md
```

Or open Claude Code in the repo directory and type:

```
Please follow the instructions in docs/AGENT-SETUP.md to set up Nexus
on this machine. Ask me whatever you need.
```

### Option 2 — fetch via URL (no checkout needed)

Most AI CLIs can read remote URLs. Tell yours:

```
Read the contents of
https://raw.githubusercontent.com/kurniarahmattt/nexus/main/docs/AGENT-SETUP.md
and follow the instructions there.
```

### Option 3 — paste it inline

Open
[the file on GitHub](https://github.com/kurniarahmattt/nexus/blob/main/docs/AGENT-SETUP.md),
copy the raw markdown, and paste it as a single prompt in your AI's
chat window.

## What the agent will do

The brief decides between two flows based on your answer to one
question:

> "Do you want to **host Nexus** for your team, or **join an existing
> Nexus** as a bridge?"

### Flow A — Host setup

Brings up the full stack on your machine. Steps it walks through:

1. Verify prerequisites (Docker, Bun, tmux, openssl, disk, RAM).
2. Clone the repo to a path you choose.
3. Generate strong secrets and write them into `.env`.
4. `make install` → `make up` → wait for healthy → `make services-up`.
5. `make bootstrap` to create the admin user and the initial bots.
6. Smoke-test by mentioning `@claude` in `#nexus-test`.
7. Hand off — tell you how to onboard teammates.

### Flow B — Bridge setup

Connects your local CLI to an existing Nexus host. Steps:

1. Collect the gateway URL, your bridge config file, your token, and the
   CLI you want to bridge.
2. Verify the CLI binary is installed and on `$PATH`.
3. Verify Bun is installed.
4. Stage the config file at a stable location (e.g. `~/.nexus/`).
5. Show you the persona / system prompt and let you edit it.
6. Fetch the prebuilt bridge bundle from the host (or clone the repo).
7. Run the bridge with your token.
8. Optionally make it persistent via systemd or a tmux session.
9. Test by mentioning your bot in a channel.

## Guardrails the brief enforces

The brief explicitly tells the agent to:

- **Always show the command before running it.** No silent side effects.
- **Ask permission for anything destructive** — installing system
  packages, modifying shell rc files, opening network ports.
- **Verify each step** before claiming success. If a health check fails,
  stop, don't move on.
- **Never paste secrets into chat.** Generate, store in `.env` or a
  file, reference by path or env var afterward.
- **Capture failure context.** If a command fails, read the last 50
  lines of output and offer specific fixes — don't blindly retry.
- **Stop on ambiguity.** If the agent can't tell which flow you want, or
  a config value is unclear, ask — don't guess.

These rules are part of the file so they travel with it; you don't have
to remind your AI of them.

## Caveats

- The brief assumes your AI has file-reading and shell-execution
  capabilities. Pure chat-only AIs (no tools) won't be able to run the
  steps — they'll only narrate them. That's still useful as a tutorial,
  but you'll have to copy-paste the commands yourself.
- The brief is conservative: it asks permission at every install /
  filesystem-modifying step. If you trust your AI more than that, tell
  it to skip confirmations.
- The brief is **not** a substitute for the [security guide](/guide/production-caveats)
  if you're going to expose Nexus to the internet — it brings the dev
  stack up cleanly, not a hardened production deploy.

## See also

- [Quick start](/guide/quick-start) — the manual five-step path.
- [Add an AI partner (bridge)](/guide/bridges) — what the host admin
  does to issue you a bridge.
