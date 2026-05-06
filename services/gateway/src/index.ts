/**
 * N.E.X.U.S Gateway — Phase 1.
 *
 * Receives Rocket.Chat outgoing webhook events, ingests raw message to Postgres
 * + (later) Redis working memory, then pushes an invoke job to BullMQ when a
 * registered bot is mentioned.
 */

import { Hono } from "hono";
import pino from "pino";
import { randomUUID } from "node:crypto";
import { RocketChatWebhook, type InvokeJob } from "@nexus/schema";
import { env } from "./env.ts";
import {
  loadAgents,
  upsertUser,
  upsertRoom,
  insertMessage,
  type AgentRow,
} from "./db.ts";
import { invokeQueue, redisConnection } from "./queues.ts";
import { fireMem0Add } from "./mem0.ts";
import { detectLandmarks, persistLandmarks } from "./landmarks.ts";
import { bridgeWSHandler, handleDispatch, bridgeStatus } from "./bridge.ts";
import apiRoutes from "./api/routes.ts";
import { Debouncer, type PendingFlush } from "./debounce.ts";

const log = pino({
  level: env.LOG_LEVEL,
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

// In-memory cache of agents loaded from DB. Small set (~4), refresh on boot.
let agentCache: AgentRow[] = [];
async function refreshAgents() {
  agentCache = await loadAgents();
  log.info({ count: agentCache.length, slugs: agentCache.map((a) => a.slug) }, "agents loaded");
}

// Match @<username> with a non-[A-Za-z0-9_-] boundary after it, so that
// `@claude-alice` does NOT also match `@claude`. Sort by username length
// descending so longer slugs like `claude-alice` are preferred when they
// overlap a shorter one.
function detectTriggeredAgents(text: string): AgentRow[] {
  const sorted = [...agentCache].sort(
    (a, b) => b.rocketchat_username.length - a.rocketchat_username.length,
  );
  const consumed = new Set<number>(); // char indices already matched
  const hits: AgentRow[] = [];
  for (const a of sorted) {
    const re = new RegExp(`@${a.rocketchat_username}(?![A-Za-z0-9_-])`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      if (consumed.has(start)) continue;
      for (let i = start; i < start + m[0].length; i++) consumed.add(i);
      if (!hits.some((h) => h.id === a.id)) hits.push(a);
      break; // one mention per agent is enough
    }
  }
  return hits;
}

function stripAllMentions(text: string, usernames: string[]): string {
  // Strip longest first to avoid leaving partial slug suffixes.
  const sorted = [...usernames].sort((a, b) => b.length - a.length);
  let out = text;
  for (const u of sorted) {
    out = out.replace(new RegExp(`@${u}(?![A-Za-z0-9_-])`, "gi"), "");
  }
  return out.replace(/\s+/g, " ").trim();
}

function inferRoomKind(
  channelId: string,
  channelName: string | undefined,
): "channel" | "private" | "dm" {
  // Rocket.Chat direct message room ids are concatenated user ids — no leading '#'.
  // Channels have 17-char hex ids; DMs have 34-char ids (two 17-char halves).
  if (channelName && channelName.startsWith("@")) return "dm";
  if (channelId.length === 34) return "dm";
  return "channel";
}

const app = new Hono();

app.get("/", (c) => c.json({ service: "nexus-gateway", version: "0.1.0", phase: 1 }));

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "nexus-gateway",
    agents: agentCache.map((a) => a.slug),
    queue: invokeQueue.name,
    bridges: bridgeStatus(),
    timestamp: new Date().toISOString(),
  }),
);

// Internal dispatch endpoint — runtime calls this for remote agents.
app.post("/internal/bridge/dispatch", async (c) => {
  const body = await c.req.json().catch(() => null);
  const result = await handleDispatch(body);
  return c.json(result);
});

// ── Nexus Web UI REST API ────────────────────────────────────────────
app.route("/api", apiRoutes);

// ── Bundled nexus-bridge.js download — served inside /admin/ so it's
//    covered by the admin auth if you later add it. ────────────────────
const BRIDGE_BUNDLE = new URL(
  "../../../packages/nexus-bridge/dist/nexus-bridge.js",
  import.meta.url,
).pathname;
app.get("/admin/download/nexus-bridge.js", async (c) => {
  const file = Bun.file(BRIDGE_BUNDLE);
  if (!(await file.exists())) {
    return c.text(
      "nexus-bridge not built. Run: make build-bridge",
      404,
    );
  }
  return new Response(file, {
    headers: {
      "content-type": "application/javascript",
      "content-disposition": 'attachment; filename="nexus-bridge.js"',
    },
  });
});

// ── Static web UI served from services/web/dist/ at /admin/* ────────
const WEB_DIST = new URL("../../web/dist/", import.meta.url).pathname;
app.get("/admin/*", async (c) => {
  const url = new URL(c.req.url);
  let path = url.pathname.replace(/^\/admin\/?/, "");
  if (!path || path === "") path = "index.html";
  try {
    const file = Bun.file(`${WEB_DIST}${path}`);
    if (await file.exists()) {
      return new Response(file);
    }
  } catch {
    /* fall through to SPA */
  }
  // SPA fallback for client-side routes (/admin/bridges/new etc.).
  const spa = Bun.file(`${WEB_DIST}index.html`);
  if (await spa.exists()) return new Response(spa, { headers: { "content-type": "text/html" } });
  return c.text("web not built — run `bun run --filter '@nexus/web' build`", 404);
});
// Redirect /admin (no trailing slash) to /admin/
app.get("/admin", (c) => c.redirect("/admin/"));

app.post("/webhook", async (c) => {
  // Rocket.Chat posts the integration's configured token in the payload's
  // `token` field. We also accept X-Nexus-Token header for internal callers.
  const raw = await c.req.json().catch(() => null);
  if (!raw) return c.json({ error: "invalid_json" }, 400);

  const parsed = RocketChatWebhook.safeParse(raw);
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues }, "webhook payload rejected");
    return c.json({ error: "invalid_payload" }, 400);
  }
  const p = parsed.data;

  if (p.token !== env.NEXUS_WEBHOOK_TOKEN) {
    log.warn({ user: p.user_name }, "token mismatch on /webhook");
    return c.json({ error: "unauthorized" }, 401);
  }

  // Skip messages from bots (any agent we manage). Defence-in-depth against loops.
  if (p.bot) {
    log.debug({ user: p.user_name }, "skip bot-originated message");
    return c.json({ ok: true, skipped: "bot_message" });
  }
  if (agentCache.some((a) => a.rocketchat_username === p.user_name)) {
    log.debug({ user: p.user_name }, "skip self message (known agent username)");
    return c.json({ ok: true, skipped: "self_message" });
  }

  // ---- Ingest ----
  const userId = await upsertUser({
    rocketchatId: p.user_id,
    username: p.user_name,
  });
  const roomKind = inferRoomKind(p.channel_id, p.channel_name);
  const roomId = await upsertRoom({
    rocketchatRid: p.channel_id,
    kind: roomKind,
    name: p.channel_name ?? null,
  });

  const ts = p.timestamp ? new Date(p.timestamp) : new Date();
  const mid = p.message_id ?? `${p.channel_id}:${ts.getTime()}`;

  const messageId = await insertMessage({
    rocketchatMid: mid,
    roomId,
    senderUserId: userId,
    senderAgentId: null,
    text: p.text,
    ts,
    metadata: {
      user_name: p.user_name,
      channel_name: p.channel_name,
      trigger_word: p.trigger_word,
    },
  });

  // ---- Phase 4 landmark detection (heuristic, cheap) ----
  if (messageId !== null) {
    const hits = detectLandmarks(p.text);
    if (hits.length > 0) {
      persistLandmarks(messageId, roomId, hits).catch((err) =>
        log.error({ err: String(err) }, "persist landmarks failed"),
      );
      log.info({ mid, kinds: hits.map((h) => h.kind) }, "landmarks detected");
    }
  }

  // ---- Async fire to Mem0 (non-blocking) ----
  const agents = detectTriggeredAgents(p.text);
  const firstSlug = agents[0]?.slug;
  fireMem0Add(
    {
      userText: p.text,
      userName: p.user_name,
      rocketchatRid: p.channel_id,
      roomKind,
      ...(firstSlug ? { targetAgentSlug: firstSlug } : {}),
    },
    log,
  );

  // ---- Debounce: combine consecutive messages from same user+room ----
  const disposition = debouncer.ingest({
    rocketchatRid: p.channel_id,
    roomId,
    triggerMessageId: mid,
    userId,
    username: p.user_name,
    text: p.text,
    ts: ts.toISOString(),
    detectedAgents: agents,
  });

  if (disposition === "ignored") {
    log.info({ room: p.channel_name, from: p.user_name }, "no bot mention, stop at ingest");
    return c.json({ ok: true, ingested: true, mid, messageId });
  }
  log.info(
    { room: p.channel_name, from: p.user_name, disposition, mentions: agents.length },
    "debounced",
  );
  return c.json({ ok: true, ingested: true, mid, debounced: disposition });
});

// Flush handler: convert a debounced buffer into invoke jobs.
async function flushToInvokeQueue(data: PendingFlush): Promise<void> {
  if (data.agents.length === 0) return;
  const usernames = data.agents.map((a) => a.rocketchat_username);
  const cleaned = stripAllMentions(data.combinedText, usernames);

  for (const agent of data.agents) {
    const job: InvokeJob = {
      jobId: randomUUID(),
      agentSlug: agent.slug,
      agentId: agent.id,
      roomId: data.roomId,
      rocketchatRid: data.rocketchatRid,
      triggerMessageId: data.triggerMessageId,
      triggerUserId: data.userId,
      triggerUsername: data.username,
      text: cleaned,
      rawText: data.combinedText,
      triggeredAt: data.firstTs,
    };
    await invokeQueue.add(`invoke:${agent.slug}`, job, {
      removeOnComplete: 1000,
      removeOnFail: 500,
    });
  }
  log.info(
    {
      agents: data.agents.map((a) => a.slug),
      from: data.username,
      combinedChars: data.combinedText.length,
    },
    "debounce flush → invoke enqueued",
  );
}

const debouncer = new Debouncer(env.NEXUS_DEBOUNCE_MS, flushToInvokeQueue);

// ---- Boot ----
await refreshAgents();

// Refresh agents every 60s to pick up new bots provisioned later.
setInterval(() => {
  refreshAgents().catch((err) => log.error({ err }, "agent refresh failed"));
}, 60_000);

// Graceful shutdown
const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  await invokeQueue.close();
  redisConnection.disconnect();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log.info({ port: env.GATEWAY_PORT }, "nexus-gateway listening");

// Bun.serve with WebSocket upgrade for /bridge.
export default {
  port: env.GATEWAY_PORT,
  fetch(req: Request, server: import("bun").Server) {
    const url = new URL(req.url);
    if (url.pathname === "/bridge") {
      const ok = server.upgrade(req, { data: { slug: null } });
      if (ok) return undefined;
      return new Response("upgrade_failed", { status: 400 });
    }
    return app.fetch(req, {});
  },
  websocket: bridgeWSHandler,
  idleTimeout: 240,
};
