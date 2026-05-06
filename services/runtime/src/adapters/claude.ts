import type { Adapter, AdapterContext, AdapterResult } from "./types.ts";
import { runProcess } from "./spawn.ts";
import { writeMcpConfig } from "./mcp.ts";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// Parse Claude Code's `--output-format stream-json --verbose` NDJSON stream
// into a Hermes-style progress log:
//
//   ⚡ running Bash `ls`…
//   ⚡ running Read `foo.ts`…
//   <final assistant text>
//
// Raw output has hook noise we ignore. Final `result` event carries the
// authoritative text — if present, we prefer it over accumulated assistant
// chunks (chunks may be missing last token in streaming).

type StreamEvent =
  | { type: "system"; subtype?: string; [k: string]: unknown }
  | {
      type: "assistant";
      message?: {
        content?: Array<
          | { type: "text"; text: string }
          | {
              type: "tool_use";
              name: string;
              input?: Record<string, unknown>;
            }
        >;
      };
    }
  | {
      type: "user";
      message?: { content?: Array<{ type: "tool_result"; is_error?: boolean }> };
    }
  | { type: "result"; subtype?: string; is_error?: boolean; result?: string }
  | { type: string; [k: string]: unknown };

function shortArg(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const v =
    (input["command"] as string) ||
    (input["file_path"] as string) ||
    (input["path"] as string) ||
    (input["pattern"] as string) ||
    (input["url"] as string) ||
    (input["description"] as string) ||
    "";
  const s = String(v).replace(/\n/g, " ").trim();
  if (!s) return "";
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

function formatProgress(state: ParseState): string {
  const lines: string[] = [];
  for (const step of state.steps) {
    lines.push(`┊ ${step}`);
  }
  // Show in-progress assistant text during streaming too.
  if (state.textSoFar) {
    if (lines.length) lines.push("");
    lines.push(state.textSoFar);
  }
  return lines.join("\n");
}

interface ParseState {
  steps: string[];
  textSoFar: string;
  finalText: string | null;
}

function parseEvents(newlineDelimitedChunk: string, buf: { residual: string }, state: ParseState) {
  const combined = buf.residual + newlineDelimitedChunk;
  const lines = combined.split("\n");
  buf.residual = lines.pop() ?? "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line) as StreamEvent;
    } catch {
      continue;
    }
    if (ev.type === "assistant") {
      const content = (ev as Extract<StreamEvent, { type: "assistant" }>).message?.content ?? [];
      for (const item of content) {
        if (item.type === "tool_use") {
          const arg = shortArg(item.name, item.input);
          state.steps.push(
            arg ? `⚡ ${item.name} \`${arg}\`` : `⚡ ${item.name}`,
          );
        } else if (item.type === "text") {
          state.textSoFar += item.text;
        }
      }
    } else if (ev.type === "result") {
      const r = ev as Extract<StreamEvent, { type: "result" }>;
      if (r.result) state.finalText = r.result;
    }
  }
}

export const claudeAdapter: Adapter = {
  slug: "claude",
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const state: ParseState = { steps: [], textSoFar: "", finalText: null };
    const buf = { residual: "" };

    const wrappedCtx: AdapterContext = {
      ...ctx,
      onChunk: ctx.onChunk
        ? async (accumulated) => {
            // Parse new events from the delta relative to what we've parsed.
            // Simpler: reparse residual + latest delta; we track via buf.
            // (accumulated is full — we pass *delta* implicitly by tracking)
            // To avoid double-parsing, use a side-channel: compare length.
            // For simplicity here: pass full accumulated, dedupe with state.
            const delta = accumulated.slice(parsedOffset.value);
            parsedOffset.value = accumulated.length;
            parseEvents(delta, buf, state);
            const preview = formatProgress(state);
            if (preview) await ctx.onChunk!(preview);
          }
        : undefined,
    };
    const parsedOffset = { value: 0 };

    const args: string[] = [
      "-p",
      ctx.userPrompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (ctx.systemPrompt) {
      // `--system-prompt` replaces the default (disables user's CLAUDE.md leak).
      args.push("--system-prompt", ctx.systemPrompt);
    }

    // Phase 6: write MCP config to temp file and attach via flag.
    const mcp = ctx.mcpConfig ? writeMcpConfig(ctx.mcpConfig) : null;
    if (mcp) args.push("--mcp-config", mcp.path);

    let res: Awaited<ReturnType<typeof runProcess>>;
    try {
      res = await runProcess(
        {
          command: CLAUDE_BIN,
          args,
          chunkFlushMs: 400,
        },
        wrappedCtx,
      );
    } finally {
      mcp?.cleanup();
    }

    // Ensure residual parsed after process exit.
    const tail = res.output.slice(parsedOffset.value);
    if (tail) parseEvents(tail, buf, state);
    if (buf.residual) parseEvents("\n", buf, state);

    // Final message: response only. Steps were visible during streaming.
    const finalText = (state.finalText ?? state.textSoFar).trim();

    return {
      ok: res.ok,
      output: finalText || "_(no response)_",
      exitCode: res.exitCode,
      durationMs: res.durationMs,
      ...(res.errorText !== undefined ? { errorText: res.errorText } : {}),
    };
  },
};
