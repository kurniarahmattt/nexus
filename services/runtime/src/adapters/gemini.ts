/**
 * Gemini CLI adapter. Plain text stdout. stderr carries warnings like:
 *
 *   Warning: unexpected file /home/.../extension-enablement.json ...
 *   Loading extension: superpowers (version: 5.0.7)
 *
 * We pipe stderr into `errorText` only (not shown to chat). Stdout is the
 * answer.
 */

import type { Adapter, AdapterContext, AdapterResult } from "./types.ts";
import { runProcess } from "./spawn.ts";

const GEMINI_BIN = process.env.GEMINI_BIN ?? "gemini";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";

// Strip noisy lines that slip into stdout on some setups.
const NOISE_RE = /^(Warning:|Loading extension:|Data collection is|Deprecated)/;

function cleanGeminiOutput(raw: string): string {
  const lines = raw.split(/\r?\n/).filter((l) => !NOISE_RE.test(l));
  return lines.join("\n").trim();
}

export const geminiAdapter: Adapter = {
  slug: "gemini",
  async run(ctx: AdapterContext): Promise<AdapterResult> {
    const wrappedCtx: AdapterContext = {
      ...ctx,
      onChunk: ctx.onChunk
        ? async (acc) => ctx.onChunk!(cleanGeminiOutput(acc))
        : undefined,
    };

    // No --system-prompt flag — prepend inline.
    const combinedPrompt = ctx.systemPrompt
      ? `[SYSTEM]\n${ctx.systemPrompt}\n[/SYSTEM]\n\n${ctx.userPrompt}`
      : ctx.userPrompt;

    const res = await runProcess(
      {
        command: GEMINI_BIN,
        args: ["-p", combinedPrompt, "-y", "-m", GEMINI_MODEL],
      },
      wrappedCtx,
    );

    return { ...res, output: cleanGeminiOutput(res.output) };
  },
};
