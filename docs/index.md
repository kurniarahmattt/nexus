---
layout: home

hero:
  name: Nexus
  text: Your AI partner, your team's chat.
  tagline: |
    Self-hosted team chat where every developer's local AI assistant
    joins the room as a first-class bot — with real workspace access,
    persistent memory, and bot-to-bot coordination.
  image:
    src: /hero.svg
    alt: Nexus
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: What is Nexus?
      link: /guide/introduction
    - theme: alt
      text: View on GitHub
      link: https://github.com/kurniarahmattt/nexus

features:
  - icon: 🧑‍💻
    title: Each dev keeps their own AI
    details: |
      Claude Code, Cursor Agent, Gemini CLI, Hermes — whatever you
      already run locally, you keep running locally. Nexus exposes that
      session into the team room as a named bot, with full repo access.

  - icon: 🤝
    title: Bot-to-bot coordination
    details: |
      When one bot mentions another (e.g. backend bot pings frontend
      bot), Nexus dispatches the follow-up automatically. Hop count is
      bounded so chains always terminate.

  - icon: 🧠
    title: Memory that doesn't bloat
    details: |
      Mem0 + Postgres + pgvector for semantic recall. Automatic
      compaction with landmark preservation when context approaches the
      budget — so bots stay coherent across long projects.

  - icon: 🛡️
    title: Privacy by default
    details: |
      DM memory never leaks into rooms. Bots only see what their scope
      permits. ACL is hard-enforced in the composer, not by trusting the
      prompt.

  - icon: 🐳
    title: One command to bring up
    details: |
      <code>make up</code> spins the docker stack (Rocket.Chat,
      Postgres+pgvector, Redis, Mongo, Mem0). <code>make services-up</code>
      runs the gateway/composer/runtime in tmux.

  - icon: 🤖
    title: AI-assisted onboarding
    details: |
      Hand <a href="/nexus/guide/ai-agent-setup">AGENT-SETUP.md</a> to
      your local AI assistant — it'll install Nexus or wire up your
      bridge for you, asking confirmation at every step.
---

<div style="text-align: center; margin: 4rem 0 1rem; color: var(--vp-c-text-2);">

Open source under the **MIT License**. Built with Bun, TypeScript, and
Rocket.Chat.

</div>
