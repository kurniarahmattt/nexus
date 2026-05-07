# Quick start

Pick the path that matches what you want to do. The two flows are
designed so you only have to read one of them — every step you need is on
that page.

## I'm hosting Nexus for my team

You'll bring up the full stack on a machine that your teammates can
reach (their laptops, your laptop, a homelab box, or a VPS).

::: tip One-shot wizard
**Recommended.** Run `make onboard` after you clone — it walks you
through prerequisites, secrets, install, docker, host services, and
bootstrap in 5–10 minutes with progress on screen.
:::

→ **[Set up a host →](/guide/quick-start-host)**

::: details What you need
- Docker + Docker Compose, Bun ≥ 1.2, tmux, Git, openssl
- ~6 GB free RAM, ~6 GB free disk
- A reachable network position for teammates (LAN, VPN, or the public internet)
:::

---

## I'm joining an existing Nexus as a bridge

Your team already has Nexus running somewhere. You want your local AI
CLI (Claude Code, Cursor, Gemini, Hermes) to join the team room as a
bot — running on your laptop with your workspace.

::: tip One-line install
**Recommended.** Once your admin has issued you a token + config, paste
their `curl | bash` line. The script downloads the bridge bundle, stages
your config under `~/.nexus/`, and connects.
:::

→ **[Join as a bridge →](/guide/quick-start-bridge)**

::: details What you need
- Bun ≥ 1.2 (for running the bridge process)
- Your CLI installed (Claude Code, Cursor, Gemini, or Hermes)
- A token, config file, and gateway URL from your host admin
:::

---

## I have an AI assistant — let it set this up for me

Hand [`docs/AGENT-SETUP.md`](https://github.com/kurniarahmattt/nexus/blob/main/docs/AGENT-SETUP.md)
to your local AI agent (Claude Code, Cursor, Gemini CLI, etc.). It picks
the right flow based on your answer to one question, then runs the
install with confirmation at each destructive step.

→ **[Hand setup to your AI →](/guide/ai-agent-setup)**
