/**
 * N.E.X.U.S Composer — Phase 3a.
 *
 * Consume InvokeJob. Build an attribution-headered prompt from room history
 * (Postgres `messages` table, last N) and the agent's stored persona. Push
 * ExecuteJob with systemPrompt + userPrompt to runtime.
 *
 * Phase 3b will add Mem0 semantic recall + user profile memories.
 */

import { Hono } from "hono";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { join } from "node:path";
import {
  QueueNames,
  InvokeJob,
  type ExecuteJob,
} from "@nexus/schema";
import { env } from "./env.ts";
import {
  getAgent,
  lastMessages,
  getRoomInfo,
  roomLandmarks,
  olderMessages,
  type LandmarkRow,
} from "./db.ts";
import { composeUserPrompt } from "./prompt.ts";
import { mem0Recall, type RecallItem } from "./mem0.ts";
import { ensureSummary, type SummaryRow } from "./summarize.ts";
import { buildMcpConfig } from "./mcp.ts";

const log = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
const executeQueue = new Queue<ExecuteJob>(QueueNames.execute, { connection });

const WORKSPACE_ROOT =
  process.env.NEXUS_WORKSPACE_ROOT ?? "/home/kurniarahmat/coding";
const SCRATCH_DIR = join(WORKSPACE_ROOT, "nexus-scratch");

const TRANSCRIPT_WINDOW = Number(process.env.NEXUS_TRANSCRIPT_WINDOW ?? 20);
/**
 * If room has more than TRANSCRIPT_WINDOW messages, we summarise the next
 * OLDER_WINDOW messages *behind* the recent window to give the bot long-range
 * context without blowing the prompt budget.
 */
const OLDER_WINDOW = Number(process.env.NEXUS_OLDER_WINDOW ?? 100);
const LANDMARK_WINDOW = Number(process.env.NEXUS_LANDMARK_WINDOW ?? 10);

const worker = new Worker<InvokeJob, { forwarded: boolean }>(
  QueueNames.invoke,
  async (job) => {
    const parsed = InvokeJob.safeParse(job.data);
    if (!parsed.success) {
      log.error({ issues: parsed.error.issues }, "invalid invoke job");
      throw new Error("invalid_invoke_job");
    }
    const data = parsed.data;

    const prompt = data.text.trim();
    if (!prompt) {
      await executeQueue.add(`execute:${data.agentSlug}`, {
        jobId: data.jobId,
        agentSlug: data.agentSlug,
        agentId: data.agentId,
        rocketchatRid: data.rocketchatRid,
        kind: "echo",
        replyText: "_(empty prompt — tell me something)_",
        systemPrompt: "",
        userPrompt: "",
        workingDirectory: "",
        triggerMessageId: data.triggerMessageId,
        hop: data.hop,
      });
      return { forwarded: true };
    }

    // ---- Load persona + room + transcript + landmarks + mem0 recall ----
    const [agent, room, transcript, landmarks, olderWin, recall] = await Promise.all([
      getAgent(data.agentSlug),
      getRoomInfo(data.roomId),
      lastMessages({ roomId: data.roomId, limit: TRANSCRIPT_WINDOW }),
      roomLandmarks(data.roomId, LANDMARK_WINDOW),
      olderMessages({
        roomId: data.roomId,
        recentLimit: TRANSCRIPT_WINDOW,
        olderLimit: OLDER_WINDOW,
      }),
      (async (): Promise<RecallItem[]> => {
        const room = await getRoomInfo(data.roomId);
        const roomKind: "channel" | "dm" = room?.kind === "dm" ? "dm" : "channel";
        try {
          return await mem0Recall({
            query: prompt,
            userName: data.triggerUsername,
            roomKind,
            rocketchatRid: data.rocketchatRid,
            targetAgentSlug: data.agentSlug,
            limit: 5,
          });
        } catch (err) {
          log.warn({ err: (err as Error).message }, "mem0 recall failed, continuing without");
          return [];
        }
      })(),
    ]);

    if (!agent) throw new Error(`agent_not_found:${data.agentSlug}`);

    // ---- Summarise older messages, if any ----
    let summary: SummaryRow | null = null;
    if (olderWin.length >= 3) {
      try {
        summary = await ensureSummary(data.roomId, olderWin);
      } catch (err) {
        log.warn({ err: (err as Error).message }, "summarize failed");
      }
    }

    const systemPrompt = agent.config.system_prompt ?? "";
    const userPrompt = composeUserPrompt({
      agentUsername: agent.rocketchat_username,
      roomName: room?.name ?? null,
      roomKind: room?.kind ?? "channel",
      triggerUsername: data.triggerUsername,
      triggerKind: data.triggerKind,
      triggerText: prompt,
      transcript,
      recall,
      landmarks,
      priorSummary: summary?.summary ?? null,
      priorSummaryRange: summary
        ? { start: summary.start_ts, end: summary.end_ts, count: summary.message_count }
        : null,
      hop: data.hop,
    });

    const mcpConfig = await buildMcpConfig().catch(() => undefined);

    const exec: ExecuteJob = {
      jobId: data.jobId,
      agentSlug: data.agentSlug,
      agentId: data.agentId,
      rocketchatRid: data.rocketchatRid,
      kind: "cli",
      replyText: "",
      systemPrompt,
      userPrompt,
      workingDirectory: SCRATCH_DIR,
      triggerMessageId: data.triggerMessageId,
      hop: data.hop,
      ...(mcpConfig ? { mcpConfig } : {}),
    };

    await executeQueue.add(`execute:${data.agentSlug}`, exec, {
      removeOnComplete: 1000,
      removeOnFail: 500,
    });

    log.info(
      {
        agent: data.agentSlug,
        from: data.triggerUsername,
        transcriptMsgs: transcript.length,
        landmarkCount: landmarks.length,
        olderMsgs: olderWin.length,
        summaryMsgs: summary?.message_count ?? 0,
        recallItems: recall.length,
        sysPromptLen: systemPrompt.length,
        userPromptLen: userPrompt.length,
        jobId: data.jobId,
      },
      "invoke → execute composed",
    );
    return { forwarded: true };
  },
  { connection, concurrency: 4 },
);

worker.on("failed", (job, err) =>
  log.error({ jobId: job?.id, err: err.message }, "invoke worker failed"),
);

// ---- Health ----
const app = new Hono();
app.get("/", (c) => c.json({ service: "nexus-composer", version: "0.3.0", phase: "3a" }));
app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "nexus-composer",
    queue: QueueNames.invoke,
    scratch: SCRATCH_DIR,
    transcript_window: TRANSCRIPT_WINDOW,
    timestamp: new Date().toISOString(),
  }),
);

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await worker.close();
  await executeQueue.close();
  connection.disconnect();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log.info(
  { port: env.COMPOSER_PORT, scratch: SCRATCH_DIR, transcriptWindow: TRANSCRIPT_WINDOW },
  "nexus-composer started",
);

export default {
  port: env.COMPOSER_PORT,
  fetch: app.fetch,
};
