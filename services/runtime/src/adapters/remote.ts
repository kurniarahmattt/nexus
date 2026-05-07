/**
 * RemoteAdapter — dispatches to a nexus-bridge over HTTP to gateway's
 * `/internal/bridge/dispatch`. Gateway forwards via WS to the connected
 * bridge. Response is the final result; no intermediate streaming in
 * Phase 6A.
 */

import { randomUUID } from "node:crypto";
import type { Adapter, AdapterContext, AdapterResult } from "./types.ts";

// Build the gateway URL from explicit GATEWAY_URL (most flexible — admin
// can put a non-localhost hostname when running runtime on a different
// host) OR from GATEWAY_PORT (which the wizard auto-relocates if 4000
// is taken). Hardcoding :4000 here was a long-standing bug: any
// installation where the wizard moved the gateway to e.g. :4010 had
// this adapter still POSTing to :4000 and getting "Failed to parse
// JSON" when whatever else was on :4000 returned non-JSON.
const GATEWAY_URL =
  process.env.GATEWAY_URL ??
  `http://localhost:${process.env.GATEWAY_PORT ?? 4000}`;

export function makeRemoteAdapter(slug: string): Adapter {
  return {
    slug,
    async run(ctx: AdapterContext): Promise<AdapterResult> {
      const jobId = randomUUID();
      const started = performance.now();
      const body: Record<string, unknown> = {
        slug,
        jobId,
        systemPrompt: ctx.systemPrompt,
        userPrompt: ctx.userPrompt,
        workingDirectory: ctx.workingDirectory,
        timeoutMs: ctx.timeoutMs,
      };
      if (ctx.mcpConfig) body.mcpConfig = ctx.mcpConfig;
      try {
        const resp = await fetch(`${GATEWAY_URL}/internal/bridge/dispatch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(ctx.timeoutMs + 10_000),
        });
        const data = (await resp.json()) as {
          ok: boolean;
          output: string;
          durationMs?: number;
          exitCode?: number | null;
          errorText?: string;
        };
        const durationMs = data.durationMs ?? Math.round(performance.now() - started);
        const res: AdapterResult = {
          ok: data.ok,
          output: data.output,
          exitCode: data.exitCode ?? null,
          durationMs,
        };
        if (data.errorText !== undefined) res.errorText = data.errorText;
        return res;
      } catch (err) {
        return {
          ok: false,
          output: "",
          exitCode: null,
          durationMs: Math.round(performance.now() - started),
          errorText: `remote dispatch: ${(err as Error).message}`,
        };
      }
    },
  };
}
