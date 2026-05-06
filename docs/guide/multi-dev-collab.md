# Multi-developer collaboration

Once two or more bridges are connected to the same channel, bot-to-bot
mention is automatic. This is the killer feature of Nexus — your AI
partner can pull in a teammate's AI partner the same way humans pull in
each other.

## How the loop works

1. Dev A asks `@bot-A` something in the channel.
2. `@bot-A` replies; if its reply mentions `@bot-B`, the gateway detects
   the mention and dispatches a follow-up invocation to `@bot-B` with a
   hop counter (`hop=1`).
3. `@bot-B` replies in the same channel, with the original context
   carried over as transcript.
4. Hops stop at `NEXUS_MAX_HOP` (default `2`) so chains always
   terminate. After that, mentions are still visible in chat — they
   just don't trigger another invocation.

```
Alice  → @bot-A  → @bot-B  → @bot-C   (hop=2)
                                ↓ stops here
                               (no further dispatch)
```

## Designing personas for peer collaboration

Personas should be explicit about each bot's domain. Add to your bridge
config's `persona`:

> *"You own the backend (code lives in /home/alice/work/api). For
> infra/deploy questions, defer to @cursor-carol-infra. For UI/frontend,
> defer to @claude-bob-frontend. Keep replies short to terminate
> bot-to-bot hops."*

Three rules of thumb:

1. **Name the domain explicitly.** Vague personas lead to bots that try
   to answer everything and don't pull in peers.
2. **Tell each bot which peer to mention** for which kinds of questions.
   The bot can't infer this from chat alone.
3. **Tell each bot to be terse.** Bot-to-bot dispatched replies become
   another bot's input — verbosity compounds.

## Example session

```
[14:02 | Alice]
  @claude-alice-backend can you summarize our current /v1/orders
  endpoints for the frontend?

[14:02 | @claude-alice-backend]
  Sure. We expose four endpoints:
  - GET  /v1/orders         → list, paginated, requires Bearer token
  - GET  /v1/orders/:id     → single order detail
  - POST /v1/orders         → create, JSON body { items: [...] }
  - PATCH /v1/orders/:id    → status update only ({ status: "..." })

  cc @claude-bob-frontend — please align the order summary card with
  these fields.

[14:02 | @claude-bob-frontend]   ← auto-dispatched (hop=1)
  Got it. The summary card currently uses `total_cents`; I'll switch to
  `total` per the new schema. I'll also need @cursor-carol-infra to
  bump the API version in staging once my PR merges.

[14:03 | @cursor-carol-infra]    ← auto-dispatched (hop=2)
  Bumped staging to v1.4. Smoke check passing. Reply chain ends here.

[14:04 | Alice]
  @claude-bob-frontend ping me when the PR is open.
```

Each bot only reads its own developer's repo (`alice/work/api` vs
`bob/work/web` vs `carol/work/deploy`). Nexus doesn't share workspaces
across machines — only the chat transcript and prompt context.

## Off-LAN considerations

Bridges work over LAN by default. For off-LAN devs, front the gateway
with TLS:

```text
# Caddyfile
nexus.team.com {
    reverse_proxy /bridge localhost:4000
    reverse_proxy /       localhost:3000
}
```

Bridges then connect to `wss://nexus.team.com/bridge`.

## Inspecting the running fleet

```bash
make list-bridges
```

shows every connected bridge plus its last-seen timestamp. Use this to
debug "the bot isn't responding" — usually the bridge has dropped its
WebSocket.

## See also

- [Add an AI partner (bridge)](/guide/bridges) — provisioning & first
  connection.
- [Architecture](/guide/architecture) — how mentions become invocations.
