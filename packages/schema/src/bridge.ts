/**
 * Bridge protocol — WS messages between nexus-bridge (client) and gateway.
 * All messages JSON-encoded.
 */

import { z } from "zod";

// ── Frames from bridge → gateway ─────────────────────────────────────
export const BridgeIdentity = z.object({
  display_name: z.string().min(1).optional(),
  persona: z.string().optional(),           // full system prompt override
  description: z.string().optional(),       // one-liner for admin UI
  model: z.string().optional(),
  cwd_override: z.string().optional(),      // let user pin a different cwd
});
export type BridgeIdentity = z.infer<typeof BridgeIdentity>;

export const BridgeHello = z.object({
  type: z.literal("hello"),
  token: z.string().min(16),
  version: z.string().default("0.1"),
  capabilities: z
    .object({
      streaming: z.boolean().default(false),
    })
    .default({ streaming: false }),
  identity: BridgeIdentity.optional(),
});

export const BridgePong = z.object({
  type: z.literal("pong"),
  ts: z.number(),
});

export const BridgeResult = z.object({
  type: z.literal("result"),
  jobId: z.string(),
  ok: z.boolean(),
  output: z.string(),
  durationMs: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  errorText: z.string().optional(),
});

export const BridgeChunk = z.object({
  type: z.literal("chunk"),
  jobId: z.string(),
  accumulated: z.string(),
});

export const BridgeClientFrame = z.discriminatedUnion("type", [
  BridgeHello,
  BridgePong,
  BridgeResult,
  BridgeChunk,
]);
export type BridgeClientFrame = z.infer<typeof BridgeClientFrame>;

// ── Frames from gateway → bridge ─────────────────────────────────────
export const BridgeWelcome = z.object({
  type: z.literal("welcome"),
  slug: z.string(),
  cli_kind: z.string(),
  cwd: z.string(),
});

export const BridgeAuthFail = z.object({
  type: z.literal("auth_fail"),
  reason: z.string(),
});

export const BridgePing = z.object({
  type: z.literal("ping"),
  ts: z.number(),
});

export const BridgeInvoke = z.object({
  type: z.literal("invoke"),
  jobId: z.string(),
  systemPrompt: z.string(),
  userPrompt: z.string(),
  workingDirectory: z.string(),
  timeoutMs: z.number().default(90_000),
  // Phase 6: MCP server config pushed to bridge; bridge writes temp JSON
  // and passes to CLI via --mcp-config (claude/cursor).
  mcpConfig: z
    .object({
      mcpServers: z.record(
        z.object({
          command: z.string(),
          args: z.array(z.string()).default([]),
          env: z.record(z.string()).default({}),
        }),
      ),
    })
    .optional(),
});

export const BridgeServerFrame = z.discriminatedUnion("type", [
  BridgeWelcome,
  BridgeAuthFail,
  BridgePing,
  BridgeInvoke,
]);
export type BridgeServerFrame = z.infer<typeof BridgeServerFrame>;

// ── Runtime → gateway internal dispatch API ──────────────────────────
export const BridgeDispatchRequest = z.object({
  slug: z.string(),
  jobId: z.string(),
  systemPrompt: z.string(),
  userPrompt: z.string(),
  workingDirectory: z.string(),
  timeoutMs: z.number().default(90_000),
  mcpConfig: z
    .object({
      mcpServers: z.record(
        z.object({
          command: z.string(),
          args: z.array(z.string()).default([]),
          env: z.record(z.string()).default({}),
        }),
      ),
    })
    .optional(),
});
export type BridgeDispatchRequest = z.infer<typeof BridgeDispatchRequest>;

export const BridgeDispatchResponse = z.object({
  ok: z.boolean(),
  output: z.string(),
  durationMs: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  errorText: z.string().optional(),
});
export type BridgeDispatchResponse = z.infer<typeof BridgeDispatchResponse>;
