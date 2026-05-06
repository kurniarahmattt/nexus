/**
 * Cursor Agent adapter. CLI `agent` (alias of cursor-agent) shares the same
 * stream-json schema as Claude Code: {type:'assistant', message:{content:[
 * {type:'text'|'tool_use', ...}]}} then {type:'result', result:'...'}.
 *
 * We reuse the NDJSON event shape from claude.ts in-lined here (cheap enough
 * to avoid cross-import); progress steps use the same ┊ ⚡ Tool format.
 */

import type { Adapter, AdapterContext, AdapterResult } from "./types.ts";
import { runProcess } from "./spawn.ts";
import { writeMcpConfig } from "./mcp.ts";

const CURSOR_BIN = process.env.CURSOR_BIN ?? "agent";

type StreamEvent =
  | { type: "system"; [k: string]: unknown }
  | {
      type: "assistant";
      message?: {
        content?: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; name: string; input?: Record<string, unknown> }
        >;
      };
    }
  | { type: "result"; result?: string; is_error?: boolean }
  | { type: string; [k: string]: unknown };

function shortArg(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const v =
    (input["command"] as string) ||
    (input["file_path"] as string) ||
    (input["path"] as string) ||
    (input["pattern"] as string) ||
    (input["url"] as string) ||
    "";
  const s = String(v).replace(/\n/g, " ").trim();
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

interface ParseState {
  steps: string[];
  textSoFar: string;
  finalText: string | null;
}

function parseEvents(
  delta: string,
  buf: { residual: string },
  state: ParseState,
) {
  const combined = buf.residual + delta;
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
      const content =
        (ev as Extract<StreamEvent, { type: "assistant" }>).message?.content ??
        [];
      for (const item of content) {
        if (item.type === "tool_use") {
          const arg = shortArg(item.input);
          state.steps.push(arg ? `⚡ ${item.name} \`${arg}\`` : `⚡ ${item.name}`);
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

function formatProgress(state: ParseState): string {
  const lines: string[] = [];
  for (const step of state.steps) lines.push(`┊ ${step}`);
  if (state.textSoFar) {
    if (lines.length) lines.push("");
    lines.push(state.textSoFar);
  }
  return lines.join("\n");
}

export const cursorAdapter: Adapter = {
  slug: "cursor",
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const state: ParseState = { steps: [], textSoFar: "", finalText: null };
    const buf = { residual: "" };
    const offset = { value: 0 };

    const wrappedCtx: AdapterContext = {
      ...ctx,
      onChunk: ctx.onChunk
        ? async (acc) => {
            const delta = acc.slice(offset.value);
            offset.value = acc.length;
            parseEvents(delta, buf, state);
            const preview = formatProgress(state);
            if (preview) await ctx.onChunk!(preview);
          }
        : undefined,
    };

    // Cursor has no --system-prompt flag — prepend inline like Hermes/Gemini.
    const combinedPrompt = ctx.systemPrompt
      ? `[SYSTEM]\n${ctx.systemPrompt}\n[/SYSTEM]\n\n${ctx.userPrompt}`
      : ctx.userPrompt;

    const mcp = ctx.mcpConfig ? writeMcpConfig(ctx.mcpConfig) : null;
    const args = [
      "-p",
      combinedPrompt,
      "--output-format",
      "stream-json",
      "--yolo",
    ];
    if (mcp) args.push("--mcp-config", mcp.path);

    let res: Awaited<ReturnType<typeof runProcess>>;
    try {
      res = await runProcess(
        { command: CURSOR_BIN, args, chunkFlushMs: 400 },
        wrappedCtx,
      );
    } finally {
      mcp?.cleanup();
    }

    const tail = res.output.slice(offset.value);
    if (tail) parseEvents(tail, buf, state);
    if (buf.residual) parseEvents("\n", buf, state);

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
