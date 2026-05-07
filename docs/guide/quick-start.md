# Quick start

```bash
curl -fsSL https://kurniarahmattt.github.io/nexus/install.sh | bash
```

This installs the `nexus` CLI on your machine. Then run **one** of the
two commands below depending on what you want.

::: tip Inspect first?
```bash
curl -fsSL https://kurniarahmattt.github.io/nexus/install.sh -o install.sh
less install.sh
bash install.sh
```
:::

## I'm hosting Nexus for my team

```bash
nexus host-onboard
```

The wizard checks prerequisites, generates strong secrets, brings up
the docker stack, starts the host services, and bootstraps Rocket.Chat.
If you don't have a Nexus checkout yet, the wizard will clone the repo
into a directory of your choice.

→ **[Set up a host (full walkthrough) →](/guide/quick-start-host)**

::: details What you need
- Docker + Docker Compose, Bun ≥ 1.2 (the installer handles Bun if missing), tmux, Git, openssl
- ~6 GB free RAM, ~6 GB free disk
- A reachable network position for teammates (LAN, VPN, or the public internet)
:::

## I'm joining an existing Nexus as a bridge

```bash
nexus onboard
```

Run this on your laptop **after** your team's host admin has issued you
a token + config file. The CLI prompts for the gateway URL, your token,
and your config file; downloads the bridge bundle from the host;
stages everything under `~/.nexus/`; and connects.

→ **[Join as a bridge (full walkthrough) →](/guide/quick-start-bridge)**

::: details What you need
- Your CLI installed (Claude Code, Cursor, Gemini, or Hermes)
- A token, config file, and gateway URL from your host admin
:::

## I have an AI assistant — let it set this up for me

Hand [`docs/AGENT-SETUP.md`](https://github.com/kurniarahmattt/nexus/blob/main/docs/AGENT-SETUP.md)
to your local AI agent (Claude Code, Cursor, Gemini CLI, etc.). It picks
the right flow based on your answer to one question, then runs the
install with confirmation at each destructive step.

→ **[Hand setup to your AI →](/guide/ai-agent-setup)**
