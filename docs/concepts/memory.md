# Memory layers

Nexus splits memory into **four layers**, each backed by a different
store. Composer queries them in a fixed order on every invocation.

| Layer       | Store              | Lifetime         | What it holds                            |
|-------------|--------------------|------------------|------------------------------------------|
| Working     | Redis              | rolling, ~50 msg | Most recent raw messages per room        |
| Episodic    | Postgres `summaries` | tiered          | Compacted summaries of older windows     |
| Semantic    | pgvector via Mem0  | indefinite       | Vector embeddings, recall by similarity  |
| Structured  | Postgres `facts`   | indefinite       | Typed key-value facts per scope          |

## Working memory (Redis)

A rolling buffer keyed by `room_id`. Stores the last ~50 raw messages
with full attribution (`{user, ts, text, attachments}`).

This is the cheapest to read and the freshest. It's what the composer
includes as "the last 40 messages" in the prompt.

## Episodic memory (Postgres `summaries`)

Hierarchical summaries that fill in for older messages. Tiers:

```
Message → Thread summary  (when thread closes or > 50 msg)
       → Session summary  (after ~1 hour of inactivity)
       → Day summary      (nightly job)
       → Week summary     (weekly job)
```

Each summary is paired with a `vector(1536)` embedding so it can be
semantic-searched alongside Mem0 facts.

## Semantic memory (Mem0 + pgvector)

Mem0 extracts **facts**, **decisions**, and **action items** from raw
messages and stores them as vector-indexed memory entries. On every
invocation, the composer runs a search:

```
mem0.search(
  query=<latest message>,
  user_id=<active user>,
  agent_id=<bot slug>,
  filter=<run_id scope>
)
```

The top-K results land in the `[RECALL]` section of the
[attribution header](/concepts/attribution).

## Structured facts (Postgres `facts`)

Strong-typed JSON values, scoped to user, project, room, or global. Used
for things that recur and should be exact (not paraphrased):

```sql
INSERT INTO facts (scope_kind, scope_id, key, value)
VALUES ('user', '<alice-uuid>', 'preferred_jwt_expiry', '"30m"');
```

These survive compaction unchanged.

## Scoping & namespacing

Mem0 entries carry `user_id`, `agent_id`, `run_id`, and a
`metadata.visibility` tag. The composer uses these for both writes and
filtered reads:

| Scope            | `user_id`     | `agent_id`     | `run_id`                       | `visibility` |
|------------------|---------------|----------------|--------------------------------|--------------|
| Room message     | `<user_uuid>` | `<agent_slug>` | `room:<room_uuid>`             | `public`     |
| DM message       | `<user_uuid>` | `<agent_slug>` | `dm:<user_uuid>:<agent_slug>`  | `private`    |
| User profile     | `<user_uuid>` | `<agent_slug>` | `profile:<user_uuid>`          | `shared`     |
| Project context  | `*`           | `<agent_slug>` | `project:<project_uuid>`       | `shared`     |

### When the agent responds in room X

```
filter = run_id IN ('room:<X>',
                    'profile:<participant_1>', ...,
                    'project:<Y>')
       AND visibility IN ('public','shared')
```

DM memory is **never** included in room responses.

### When the agent responds in DM with user U

```
filter = run_id IN ('dm:<U>:<agent>',
                    'profile:<U>',
                    'project:<Y>')
       AND ((visibility = 'private' AND user_id = <U>)
            OR visibility = 'shared')
```

Other users' DM memory is **never** included.

This is hard-enforced in the composer — not delegated to the prompt.
The prompt is treated as untrusted; ACL lives in code.

## Compaction trigger

When the estimated token count for the proposed prompt exceeds **70% of
the agent's context window**, the composer triggers
[compaction](/concepts/compaction) inline. The window-to-compact gets
replaced with `summary + landmarks`.

## Rule of thumb

- Need the **last hour** of conversation? Working memory.
- Need to recall **what we discussed last week**? Semantic search hits
  episodic summaries.
- Need to remember a user's **preference**? Structured facts.
- Need to know **a decision was made**? Landmarks (see
  [Compaction](/concepts/compaction)) — never deleted, always pinned.
