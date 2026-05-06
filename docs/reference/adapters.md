# Adding a CLI adapter

Each CLI agent (Claude Code, Cursor Agent, Gemini CLI, Hermes) gets its
own adapter under
[`services/runtime/src/adapters/`](https://github.com/kurniarahmattt/nexus/tree/main/services/runtime/src/adapters).
The adapter pattern makes adding a new CLI a small, mechanical change.

## Adapter responsibilities

Each adapter exports an object that satisfies the contract in
[`adapters/types.ts`](https://github.com/kurniarahmattt/nexus/blob/main/services/runtime/src/adapters/types.ts):

```typescript
export interface Adapter {
  slug: string;                      // 'claude', 'hermes', 'cursor', 'gemini'
  spawn(opts: SpawnOpts): Promise<AdapterStream>;
}

export interface SpawnOpts {
  prompt: string;
  cwd: string;
  abortSignal?: AbortSignal;
  // …per-CLI options
}

export interface AdapterStream {
  chunks: AsyncIterable<string>;     // streamed stdout, ANSI/TUI cleaned
  done: Promise<{ exitCode: number }>;
}
```

## Recipe

### 1. Create the file

```bash
touch services/runtime/src/adapters/<your-cli>.ts
```

### 2. Implement `spawn()`

Use the shared spawn helper (`./spawn.ts`) which manages PTY lifecycle:

```typescript
import { spawnPTY } from "./spawn.ts";
import type { Adapter } from "./types.ts";

const BIN = process.env.YOUR_CLI_BIN ?? "your-cli";

export const yourCli: Adapter = {
  slug: "your-cli",
  async spawn({ prompt, cwd }) {
    return spawnPTY({
      command: BIN,
      args: ["--non-interactive", "--prompt", prompt],
      cwd,
      chunkFlushMs: 400,
    });
  },
};
```

### 3. Strip TUI/ANSI noise (if needed)

If the CLI emits curses-style escape codes or progress bars, add a
filter. The shared helper `cleanStream()` in `spawn.ts` handles ANSI
already. For richer cases (Claude's `stream-json` mode, for example),
parse the structured output:

```typescript
// extract only the assistant message text
for await (const line of rawChunks) {
  const ev = safeJSON(line);
  if (ev?.type === "assistant" && ev.message?.content) {
    yield extractText(ev.message.content);
  }
}
```

See `claude.ts` for a full example.

### 4. Detect tool_call patterns (Phase 6+)

If the CLI emits structured tool-call invocations (most modern agentic
CLIs do), match them and forward to the MCP layer. The current Claude
adapter parses Claude's `stream-json` events; Cursor uses an HTTP
control channel; Gemini emits inline JSON.

### 5. Register in the index

Open
[`services/runtime/src/adapters/index.ts`](https://github.com/kurniarahmattt/nexus/blob/main/services/runtime/src/adapters/index.ts)
and add your adapter:

```typescript
import { yourCli } from "./your-cli.ts";

const adapters: Record<string, Adapter> = {
  claude: claudeAdapter,
  hermes: hermesAdapter,
  cursor: cursorAdapter,
  gemini: geminiAdapter,
  "your-cli": yourCli,    // ← here
};
```

### 6. Add a seed migration

Append a new migration in `db/migrations/`:

```sql
-- 0008_add_your_cli_agent.sql
INSERT INTO agents (slug, display_name, cli_command, cli_args, rocketchat_username, config, enabled)
VALUES (
  'your-cli',
  'Your CLI',
  'your-cli',                   -- bare command, $PATH-resolved
  '[]'::jsonb,
  'your-cli',
  jsonb_build_object(
    'description', 'Short description shown in admin UI.',
    'system_prompt',
      'You are @your-cli, an AI assistant in the Nexus team chat...'
  ),
  true
)
ON CONFLICT (slug) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  cli_command  = EXCLUDED.cli_command,
  config       = agents.config || (EXCLUDED.config - 'auth_token' - 'auth_user_id'),
  updated_at   = now();

INSERT INTO schema_migrations (version) VALUES ('0008_add_your_cli_agent') ON CONFLICT DO NOTHING;
```

### 7. Bootstrap the bot user

Re-run `make bootstrap` to create the `@your-cli` Rocket.Chat user.

### 8. Add a test invocation

```bash
# in any channel
@your-cli hello
```

Verify it replies. If it doesn't, check `make services-status` and
`make logs`.

## Conventions

- **Bare command name** in `cli_command` (the `$PATH`-resolved binary).
  Override path with `<UPPERCASE>_BIN` env var.
- **Stateless invocation**: spawn per turn; no long-running PTY in v1.
- **Streamed output**: yield chunks as they arrive; don't buffer the
  full reply.
- **No prompt rewriting**: the composer builds the full attribution
  header. Adapters should pass it through verbatim.

## Reference adapters

Read these in order of complexity:

1. [`hermes.ts`](https://github.com/kurniarahmattt/nexus/blob/main/services/runtime/src/adapters/hermes.ts)
   — simplest, pure stdin/stdout
2. [`gemini.ts`](https://github.com/kurniarahmattt/nexus/blob/main/services/runtime/src/adapters/gemini.ts)
   — same pattern, slight CLI flag differences
3. [`cursor.ts`](https://github.com/kurniarahmattt/nexus/blob/main/services/runtime/src/adapters/cursor.ts)
   — non-interactive Cursor agent mode
4. [`claude.ts`](https://github.com/kurniarahmattt/nexus/blob/main/services/runtime/src/adapters/claude.ts)
   — `stream-json` output parsing, most involved
