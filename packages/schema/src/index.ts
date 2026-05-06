/**
 * Shared types & zod schemas untuk semua service N.E.X.U.S.
 */

import { z } from "zod";

export * from "./bridge.ts";

// ---- Memory scoping (ref: PLANNING.md §5.2) ----

export const MemoryVisibility = z.enum(["public", "private", "shared"]);
export type MemoryVisibility = z.infer<typeof MemoryVisibility>;

export const RoomKind = z.enum(["channel", "private", "dm"]);
export type RoomKind = z.infer<typeof RoomKind>;

// ---- Rocket.Chat Outgoing Webhook payload ----
// Ref: https://docs.rocket.chat/use-rocket.chat/workspace-administration/integrations

export const RocketChatWebhook = z.object({
  token: z.string(),
  message_id: z.string().optional(),
  timestamp: z.string().optional(),
  channel_id: z.string(),
  channel_name: z.string().optional(),
  user_id: z.string(),
  user_name: z.string(),
  text: z.string().default(""),
  trigger_word: z.string().optional(),
  bot: z.union([z.boolean(), z.object({ i: z.string() })]).optional(),
});
export type RocketChatWebhook = z.infer<typeof RocketChatWebhook>;

// ---- Invocation job (gateway → composer) ----

export const InvokeJob = z.object({
  jobId: z.string(),
  agentSlug: z.string(),           // 'claude' | 'hermes' | remote slug
  agentId: z.string().uuid(),
  roomId: z.string().uuid(),
  rocketchatRid: z.string(),       // channel_id from webhook (Rocket.Chat room id)
  triggerMessageId: z.string(),
  triggerUserId: z.string().uuid().optional(), // undefined if trigger is a bot (bot-to-bot hop)
  triggerAgentId: z.string().uuid().optional(),
  triggerUsername: z.string(),     // human username or bot slug
  triggerKind: z.enum(["user", "agent"]).default("user"),
  text: z.string(),                // cleaned text (mention stripped)
  rawText: z.string(),
  triggeredAt: z.string().datetime(),
  hop: z.number().int().min(0).default(0), // bot-to-bot depth
});
export type InvokeJob = z.infer<typeof InvokeJob>;

// ---- Execute job (composer → runtime) ----

export const McpServerConfig = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
});
export type McpServerConfig = z.infer<typeof McpServerConfig>;

export const McpConfig = z.object({
  mcpServers: z.record(McpServerConfig).default({}),
});
export type McpConfig = z.infer<typeof McpConfig>;

export const ExecuteJob = z.object({
  jobId: z.string(),
  agentSlug: z.string(),
  agentId: z.string().uuid(),
  rocketchatRid: z.string(),
  // 'echo'  → post replyText verbatim (Phase 1 compat, empty prompts).
  // 'cli'   → spawn agent CLI, feed userPrompt (and systemPrompt if supported).
  kind: z.enum(["echo", "cli"]).default("cli"),
  replyText: z.string().default(""),
  // Phase 3a: composer builds both.
  systemPrompt: z.string().default(""),   // persona
  userPrompt: z.string().default(""),     // attribution header + transcript + task
  workingDirectory: z.string().default(""),
  triggerMessageId: z.string().default(""),
  hop: z.number().int().min(0).default(0),
  // Phase 6: MCP servers the CLI should spawn for this invocation.
  mcpConfig: McpConfig.optional(),
});
export type ExecuteJob = z.infer<typeof ExecuteJob>;

// ---- Queue names ----

export const QueueNames = {
  invoke: "nexus_invoke",
  execute: "nexus_execute",
} as const;

// ---- Audit event ----

export const AuditEvent = z.object({
  eventType: z.enum([
    "invoke",
    "tool_call",
    "tool_approve",
    "tool_deny",
    "compaction",
    "bot_provisioned",
    "room_attached",
  ]),
  actorUserId: z.string().uuid().optional(),
  actorAgentId: z.string().uuid().optional(),
  roomId: z.string().uuid().optional(),
  payload: z.record(z.unknown()).default({}),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
