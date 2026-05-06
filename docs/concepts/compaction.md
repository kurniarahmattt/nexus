# Compaction engine

Long-running rooms accumulate too much chat to fit in any agent's
context window. Nexus compacts older windows into summaries while
**preserving landmarks** — messages that should never be paraphrased
(decisions, specs, important code).

## Trigger

Compaction kicks in when the **estimated token count** for the proposed
prompt exceeds **70% of the agent's context budget**. The check runs
inline in the composer, before the prompt is sent to the runtime.

## Algorithm

1. **Identify the window** to compact — typically the oldest messages
   that don't yet have a summary.
2. **Detect landmarks** in the window. Heuristics:
   - Contains `decision:` or `spec:`
   - Contains a code block ≥ 20 lines
   - `@mention` plus an imperative verb ("please ship", "fix this", …)
   - Links to a spec or design doc
3. **Pin landmarks** into the `landmarks` table — they are never
   compacted.
4. **Send non-landmarks to an LLM summarizer** with the prompt:
   *"Extract facts, decisions, action items, unresolved questions.
   Preserve speaker attribution."*
5. **Store the summary** in the `summaries` table with an embedding.
6. **At compose time**, replace the old raw window with
   `summary + landmarks (full text)`.

## Tier cascade

Summaries themselves are tiered. Each tier is finer-grained than the
next, and an older tier can be re-summarized into a coarser one.

```
Message → Thread summary  (when a thread closes or > 50 messages)
       → Session summary  (after ~1 hour of inactivity)
       → Day summary      (nightly job)
       → Week summary     (weekly job)
```

The longer ago, the coarser the resolution. There is always a **vector
search fallback** if the user asks for older details
(*"recall the discussion from 2026-03-12"*) — the composer queries the
full `summaries` table by embedding similarity.

## Landmarks

Landmarks live in the `landmarks` table:

```sql
CREATE TABLE landmarks (
  id          BIGSERIAL PRIMARY KEY,
  message_id  BIGINT REFERENCES messages(id),
  room_id     UUID REFERENCES rooms(id),
  kind        TEXT,   -- 'decision','spec','code','link','question','action_item'
  reason      TEXT,
  extracted_by TEXT,  -- 'heuristic' or 'llm'
  pinned_at   TIMESTAMPTZ DEFAULT now()
);
```

A landmark message is included **verbatim** in every future prompt for
that room — even if it's a year old. This is the only mechanism that
guarantees exact text survives compaction.

Manually pinning a message: there's a future Web UI affordance for this;
for now, insert the row directly or use `/skill` once Phase 8 lands.

## Manual triggers

For long-running rooms, you can trigger compaction off-hours via:

```bash
# planned target
make compact ROOM=<rocketchat_rid>
```

## Cron

The full tier cascade runs on a cron schedule:

| Tier        | Cadence    | Worker                                    |
|-------------|------------|-------------------------------------------|
| Thread      | on-close   | Inline in composer                        |
| Session     | hourly     | Composer cron                             |
| Day         | nightly    | Composer cron (configurable, default 03:00)|
| Week        | weekly     | Composer cron (configurable, Sun 04:00)    |

Sweep behavior: the worker scans rooms active in the relevant window,
finds gaps without summaries, and fills them. Idempotent.

## What if it fails?

If the summarizer LLM fails (timeout, API error, etc.), the composer
falls back to **truncating** the window: oldest raw messages get
dropped to fit budget. Landmarks are still preserved. The skipped
window is retried next compaction cycle.

This is observable via:

```bash
# from the composer logs
make logs | grep -i compact
```

## Tuning

Two env knobs in `.env`:

```bash
NEXUS_TRANSCRIPT_WINDOW=20    # raw messages kept verbatim
NEXUS_OLDER_WINDOW=100        # summarized window behind the recent one
NEXUS_LANDMARK_WINDOW=10      # landmarks scanned in the visible range
```

Lower the transcript window to save budget on long rooms; raise it for
short, intense pair-programming sessions where every message matters.
