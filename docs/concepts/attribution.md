# Attribution format

Every transcript handed to a CLI agent carries an explicit, structured
header. The format is deterministic and readable; CLI agents digest it
without prompt-engineering tricks.

## Anatomy

```
[SESSION CONTEXT]
Room: #auth-team (project: saga-ai)
Participants: Andi (backend lead), Budi (frontend), Carol
You are: @claude (Claude Code CLI agent)
Time: 2026-04-21 14:02 Asia/Jakarta

[RECALL — from long-term memory]
- Andi previously stated a preference for 30 min JWT expiry
  (fact, 2026-04-15, DM)
- Project saga-ai uses NestJS + Prisma (project memory)

[LANDMARKS — pinned decisions]
- [2026-04-10] Team agreed on refresh-token rotation (by Budi)

[EPISODIC SUMMARY — last session]
Yesterday Andi & Budi discussed a race-condition bug in the auth
middleware; Andi is investigating, not yet resolved.

[RAW TRANSCRIPT — most recent 40 messages]
[14:02 | Andi] @claude why is the token expiry only 15 minutes?
[14:02 | Budi] I'd suggest 30 minutes
[14:03 | Andi] yes, users complained

[CURRENT INVOCATION]
Respond to Andi and Budi in room #auth-team.
```

## Why each section

| Section              | Purpose                                                                |
|----------------------|------------------------------------------------------------------------|
| `SESSION CONTEXT`    | Tells the bot **who it is**, **where it is**, **who it's talking to**. |
| `RECALL`             | Mem0 hits relevant to the last user message.                           |
| `LANDMARKS`          | Pinned decisions / specs / important code that survives compaction.    |
| `EPISODIC SUMMARY`   | Compacted older context, replacing raw messages outside the window.    |
| `RAW TRANSCRIPT`     | Most recent N messages verbatim, with `[time \| sender]` lines.        |
| `CURRENT INVOCATION` | The one thing the bot is being asked to do *right now*.                |

## Why explicit attribution

In a multi-human + multi-AI room, the model **must** know:

- Which user it's responding to (so its reply addresses them by name).
- Which other users are participants (so it can defer or pull them in).
- Which user's profile each fact came from (so it doesn't conflate
  preferences).
- That it is one of multiple bots (so it doesn't impersonate `@hermes`).
- The DM-vs-room context (so it doesn't leak DM memory).

Without an attribution header, the model has to guess from chat
formatting alone — and CLI agents weren't trained on chat formats.

## Where it's built

The header is assembled by `services/composer/src/prompt.ts`. The
function pulls each section from the corresponding memory layer (see
[Memory layers](/concepts/memory)), formats it, and joins with the raw
transcript.

The full prompt then goes to the runtime, which spawns the right CLI
adapter. Each adapter strips ANSI/TUI noise from the streamed reply
before posting to Rocket.Chat.

## Implication for personas

Don't write personas that say *"You will receive [SESSION CONTEXT] and
[RECALL] sections..."*. The bot already knows the format from the data
shape. Personas should focus on **role, scope, voice, and peer
relationships** — not on the prompt layout.
