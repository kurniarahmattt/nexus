/**
 * RemoteAdapter — dispatches to a nexus-bridge over HTTP to gateway's
 * `/internal/bridge/dispatch`. Gateway forwards via WS to the connected
 * bridge. Response is the final result; no intermediate streaming in
 * Phase 6A.
 */

import { randomUUID } from "node:crypto";
import type { Adapter, AdapterContext, AdapterResult } from "./types.ts";

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:4000";

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
