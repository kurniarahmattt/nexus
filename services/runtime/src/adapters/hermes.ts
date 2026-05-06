import type { Adapter, AdapterContext, AdapterResult } from "./types.ts";
import { runProcess } from "./spawn.ts";

const HERMES_BIN = process.env.HERMES_BIN ?? "hermes";

// Hermes `-Q` still renders TUI box header + duplicates streaming tool preview
// lines. Clean output:
//   1. Strip ANSI escape codes.
//   2. Drop lines containing Unicode box drawing chars.
//   3. Drop "session_id:" trailer and anything after.
//   4. Drop lines that start with 4+ leading spaces (tool-preview indent).
//   5. Collapse consecutive blank lines.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const BOX_CHARS = /[─│╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬▌▐▀▄█]/;

interface CleanOpts {
  /** Keep progress lines (starting with ┊). True during streaming, false final. */
  keepProgress: boolean;
}

function cleanHermesOutput(raw: string, opts: CleanOpts): string {
  // Strip Nous Hermes 3 harmony-style channel tokens leaking into output:
  //   <|channel>thought<channel|>...<|channel>final<channel|>response
  // Drop the metadata + keep visible text. We run this BEFORE ANSI strip
  // because the tokens are plain ASCII.
  let cleaned = raw
    // Paired: <|channel>NAME<channel|>  (drop both tag and intervening name)
    .replace(/<\|channel\|?>[\s\S]*?<\|?channel\|>/g, "")
    // Unpaired stragglers.
    .replace(/<\|channel\|?>/g, "")
    .replace(/<\|?channel\|>/g, "");

  cleaned = cleaned.replace(ANSI_RE, "");
  const lines: string[] = [];
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.replace(/\r/g, "");
    if (line.startsWith("session_id:")) break;
    if (BOX_CHARS.test(line)) continue;
    if (/^\s{4,}\S/.test(line)) continue; // tool-preview indent
    if (!opts.keepProgress && /^\s*┊/.test(line)) continue; // drop progress line in final
    lines.push(line);
  }
  const collapsed: string[] = [];
  let prevBlank = true;
  for (const l of lines) {
    const blank = l.trim() === "";
    if (blank && prevBlank) continue;
    collapsed.push(l);
    prevBlank = blank;
  }
  return collapsed.join("\n").trim();
}

export const hermesAdapter: Adapter = {
  slug: "hermes",
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    // During streaming: keep progress lines (┊ ...). Final: drop them.
    const cleanedCtx: AdapterContext = {
      ...ctx,
      onChunk: ctx.onChunk
        ? async (acc) =>
            ctx.onChunk!(cleanHermesOutput(acc, { keepProgress: true }))
        : undefined,
    };

    // Hermes CLI has no --system-prompt flag; prepend persona inline.
    const combinedPrompt = ctx.systemPrompt
      ? `[SYSTEM]\n${ctx.systemPrompt}\n[/SYSTEM]\n\n${ctx.userPrompt}`
      : ctx.userPrompt;

    const res = await runProcess(
      {
        command: HERMES_BIN,
        args: ["chat", "-q", combinedPrompt, "-Q", "--yolo"],
        env: { TERM: "dumb", NO_COLOR: "1" },
      },
      cleanedCtx,
    );
    return { ...res, output: cleanHermesOutput(res.output, { keepProgress: false }) };
  },
};
