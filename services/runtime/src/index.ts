/**
 * N.E.X.U.S Runtime — Phase 2.
 *
 * Consumes ExecuteJob. Routes by `kind`:
 *   - echo: post `replyText` verbatim (Phase 1 compat).
 *   - cli:  resolve adapter for agentSlug, spawn subprocess, stream stdout
 *           via chat.update to the bot's initial placeholder message.
 */

import { Hono } from "hono";
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import pino from "pino";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  QueueNames,
  ExecuteJob,
  type InvokeJob,
} from "@nexus/schema";
import { env } from "./env.ts";
import { getAgentCreds, allBots, roomIdFromRid } from "./db.ts";
import { sendMessage, updateMessage } from "./rocketchat.ts";
import { getAdapter, knownSlugs } from "./adapters/index.ts";
import { postFallback, warmFallback } from "./fallback.ts";
import { renderMermaidLinks } from "./mermaid.ts";

const log = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

// Invoke queue producer for bot-to-bot hops.
const invokeQueue = new Queue<InvokeJob>(QueueNames.invoke, { connection });

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_MSG_CHARS = 5000; // RC max message length-ish; trim to be safe
const MAX_HOP = Number(process.env.NEXUS_MAX_HOP ?? 2);

function truncateForChat(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_MSG_CHARS) return trimmed;
  return trimmed.slice(0, MAX_MSG_CHARS) + "\n\n_…(truncated)_";
}

const worker = new Worker<ExecuteJob, { messageId: string }>(
  QueueNames.execute,
  async (job) => {
    const parsed = ExecuteJob.safeParse(job.data);
    if (!parsed.success) {
      log.error({ issues: parsed.error.issues }, "invalid execute job");
      throw new Error("invalid_execute_job");
    }
    const data = parsed.data;

    const creds = await getAgentCreds(data.agentSlug);
    if (!creds) {
      // No bot auth_token — can't post as bot. Surface via admin fallback.
      const msg =
        `⚠️ \`@${data.agentSlug}\` tidak bisa merespons — credentials belum ter-setup. ` +
        "Jalankan `make bootstrap` untuk capture token bot.";
      await postFallback(data.rocketchatRid, msg).catch(() => undefined);
      throw new Error(`missing_credentials:${data.agentSlug}`);
    }

    // ---- ECHO path (Phase 1 compat, empty prompts) ----
    if (data.kind === "echo") {
      const msgId = await sendMessage({
        rid: data.rocketchatRid,
        text: data.replyText || "(empty)",
        authToken: creds.auth_token,
        userId: creds.auth_user_id,
      });
      log.info({ agent: data.agentSlug, mid: msgId, jobId: data.jobId }, "echo posted");
      return { messageId: msgId };
    }

    // ---- CLI path ----
    const adapter = getAdapter(data.agentSlug, creds.kind);
    if (!adapter) {
      log.error(
        { slug: data.agentSlug, kind: creds.kind, known: knownSlugs() },
        "no adapter for agent",
      );
      const errId = await sendMessage({
        rid: data.rocketchatRid,
        text: `⚠️ no adapter for '${data.agentSlug}' (kind=${creds.kind})`,
        authToken: creds.auth_token,
        userId: creds.auth_user_id,
      });
      return { messageId: errId };
    }

    // Ensure workspace exists.
    const cwd = data.workingDirectory || "/tmp";
    await mkdir(cwd, { recursive: true }).catch(() => {});

    // Post a placeholder message we'll edit as stdout streams in.
    const placeholderMid = await sendMessage({
      rid: data.rocketchatRid,
      text: `🤔 _thinking..._`,
      authToken: creds.auth_token,
      userId: creds.auth_user_id,
    });

    // Throttled edit — skip edit if content unchanged since last flush.
    let lastEditedContent = "";
    const postChunk = async (accumulated: string) => {
      const preview = truncateForChat(accumulated);
      if (!preview || preview === lastEditedContent) return;
      lastEditedContent = preview;
      try {
        await updateMessage({
          rid: data.rocketchatRid,
          msgId: placeholderMid,
          text: preview + "\n\n_▌_",
          authToken: creds.auth_token,
          userId: creds.auth_user_id,
        });
      } catch (err) {
        log.warn({ err: (err as Error).message }, "chat.update mid-stream failed");
      }
    };

    log.info(
      {
        agent: data.agentSlug,
        cwd,
        sysPromptLen: data.systemPrompt.length,
        userPromptLen: data.userPrompt.length,
        jobId: data.jobId,
      },
      "spawning CLI adapter",
    );

    // Wrap adapter.run — if the CLI binary is missing or runtime throws
    // unexpectedly (not a clean {ok:false}), convert to a user-visible error
    // message instead of letting BullMQ silently fail.
    let result: Awaited<ReturnType<typeof adapter.run>>;
    try {
      result = await adapter.run({
        systemPrompt: data.systemPrompt,
        userPrompt: data.userPrompt,
        workingDirectory: cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        onChunk: postChunk,
        ...(data.mcpConfig ? { mcpConfig: data.mcpConfig } : {}),
      });
    } catch (err) {
      const reason = (err as Error).message || "unknown";
      log.error({ agent: data.agentSlug, err: reason }, "adapter threw unhandled");
      await updateMessage({
        rid: data.rocketchatRid,
        msgId: placeholderMid,
        text: `⚠️ \`@${data.agentSlug}\` crashed: ${reason}\n_(adapter threw — check runtime log)_`,
        authToken: creds.auth_token,
        userId: creds.auth_user_id,
      }).catch(() => undefined);
      return { messageId: placeholderMid };
    }

    // Final update (remove cursor glyph). Inject kroki links for mermaid
    // diagrams so RC's image preview shows the rendered chart inline.
    const successBody = renderMermaidLinks(result.output);
    const finalText = result.ok
      ? truncateForChat(successBody) ||
        "_(empty response from agent)_"
      : `⚠️ \`${data.agentSlug}\` failed (${result.errorText ?? "unknown"})` +
        (result.output.trim() ? `\n\n${truncateForChat(result.output)}` : "");

    await updateMessage({
      rid: data.rocketchatRid,
      msgId: placeholderMid,
      text: finalText,
      authToken: creds.auth_token,
      userId: creds.auth_user_id,
    }).catch((err) =>
      log.error({ err: (err as Error).message }, "final chat.update failed"),
    );

    log.info(
      {
        agent: data.agentSlug,
        ok: result.ok,
        exit: result.exitCode,
        durMs: result.durationMs,
        mid: placeholderMid,
        jobId: data.jobId,
      },
      "CLI reply complete",
    );

    // ---- Bot-to-bot hop ----
    // Scan reply text for mentions of OTHER bots; if found and hop budget
    // remains, enqueue an internal invoke so the target bot sees it.
    if (result.ok && result.output) {
      await maybeHop({
        agentSlug: data.agentSlug,
        agentId: data.agentId,
        roomId: await roomIdFromRid(data.rocketchatRid),
        rocketchatRid: data.rocketchatRid,
        triggerMessageId: placeholderMid,
        text: result.output,
        currentHop: (data as ExecuteJob & { hop?: number }).hop ?? 0,
      }).catch((err) =>
        log.warn({ err: (err as Error).message }, "hop enqueue failed"),
      );
    }

    return { messageId: placeholderMid };
  },
  { connection, concurrency: 2 },
);

async function maybeHop(args: {
  agentSlug: string;
  agentId: string;
  roomId: string | null;
  rocketchatRid: string;
  triggerMessageId: string;
  text: string;
  currentHop: number;
}): Promise<void> {
  if (!args.roomId) return;
  if (args.currentHop >= MAX_HOP) {
    log.info({ hop: args.currentHop }, "hop budget exhausted, drop");
    return;
  }
  const bots = await allBots();
  // Match longest-first with word boundary — prevents @claude matching in
  // @claude-alice/@claude-bob.
  const sorted = [...bots].sort(
    (a, b) => b.rocketchat_username.length - a.rocketchat_username.length,
  );
  const targets: typeof bots = [];
  const consumed = new Set<number>();
  for (const b of sorted) {
    if (b.slug === args.agentSlug) continue;
    const re = new RegExp(`@${b.rocketchat_username}(?![A-Za-z0-9_-])`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(args.text)) !== null) {
      if (consumed.has(m.index)) continue;
      for (let i = m.index; i < m.index + m[0].length; i++) consumed.add(i);
      if (!targets.some((t) => t.id === b.id)) targets.push(b);
      break;
    }
  }
  if (targets.length === 0) return;
  const nextHop = args.currentHop + 1;
  for (const t of targets) {
    const job: InvokeJob = {
      jobId: randomUUID(),
      agentSlug: t.slug,
      agentId: t.id,
      roomId: args.roomId,
      rocketchatRid: args.rocketchatRid,
      triggerMessageId: args.triggerMessageId,
      triggerAgentId: args.agentId,
      triggerUsername: args.agentSlug,
      triggerKind: "agent",
      text: args.text.replace(
        new RegExp(`@${t.rocketchat_username}\\b`, "gi"),
        "",
      ).trim(),
      rawText: args.text,
      triggeredAt: new Date().toISOString(),
      hop: nextHop,
    };
    await invokeQueue.add(`invoke:${t.slug}`, job, {
      removeOnComplete: 1000,
      removeOnFail: 500,
    });
    log.info(
      { from: args.agentSlug, to: t.slug, hop: nextHop },
      "bot-to-bot hop enqueued",
    );
  }
}

worker.on("failed", (job, err) =>
  log.error({ jobId: job?.id, err: err.message }, "execute worker failed"),
);

// ---- Health ----
const app = new Hono();
app.get("/", (c) => c.json({ service: "nexus-runtime", version: "0.5.0", phase: 5 }));
app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "nexus-runtime",
    queue: QueueNames.execute,
    rocketchat_url: env.ROCKETCHAT_URL,
    adapters: knownSlugs(),
    timestamp: new Date().toISOString(),
  }),
);

// Preflight: invoke each adapter with a trivial "say ok" prompt and report
// which binaries are alive. Useful for Mas to debug missing CLIs.
app.get("/preflight", async (c) => {
  const { pool } = await import("./db.ts");
  const results: Array<{ slug: string; ok: boolean; durMs: number; reason?: string }> = [];
  for (const slug of knownSlugs()) {
    const adapter = getAdapter(slug)!;
    const creds = await getAgentCreds(slug);
    if (!creds) {
      results.push({ slug, ok: false, durMs: 0, reason: "no auth_token in DB" });
      continue;
    }
    try {
      const r = await adapter.run({
        systemPrompt: "",
        userPrompt: "Reply only with: ok",
        workingDirectory: "/tmp",
        timeoutMs: 60_000,
      });
      const ret: { slug: string; ok: boolean; durMs: number; reason?: string } = {
        slug,
        ok: r.ok,
        durMs: r.durationMs,
      };
      if (!r.ok) ret.reason = r.errorText ?? "failed";
      results.push(ret);
    } catch (err) {
      results.push({
        slug,
        ok: false,
        durMs: 0,
        reason: (err as Error).message,
      });
    }
  }
  void pool; // keep import side-effect reachable
  return c.json({ preflight: results, timestamp: new Date().toISOString() });
});

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await worker.close();
  connection.disconnect();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Warm admin fallback creds eagerly so first failure is instant.
void warmFallback().then((ok) =>
  log.info({ fallbackReady: ok }, "fallback poster init"),
);

log.info({ port: env.RUNTIME_PORT, adapters: knownSlugs() }, "nexus-runtime started");

export default {
  port: env.RUNTIME_PORT,
  fetch: app.fetch,
  // Long enough for /preflight to run all 4 CLI adapters sequentially.
  idleTimeout: 240,
};
