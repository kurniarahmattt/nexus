/**
 * N.E.X.U.S Gateway — Phase 1.
 *
 * Receives Rocket.Chat outgoing webhook events, ingests raw message to Postgres
 * + (later) Redis working memory, then pushes an invoke job to BullMQ when a
 * registered bot is mentioned.
 */

import { Hono } from "hono";
import pino from "pino";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { RocketChatWebhook, type InvokeJob } from "@nexus/schema";
import { env } from "./env.ts";
import {
  loadAgents,
  upsertUser,
  upsertRoom,
  insertMessage,
  type AgentRow,
} from "./db.ts";
import { pool } from "./db.ts";
import { invokeQueue, redisConnection } from "./queues.ts";
import { fireMem0Add } from "./mem0.ts";
import { detectLandmarks, persistLandmarks } from "./landmarks.ts";
import { bridgeWSHandler, handleDispatch, bridgeStatus } from "./bridge.ts";
import { createUser as rcCreateUser, botLogin as rcBotLogin } from "./api/rc.ts";
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

// ── Bridge join codes (one-shot credential exchange) ─────────────────
// GET /join/:code  → preview only (HTML + safe JSON, NO consumption)
// POST /join/:code → consume (returns full credentials, marks consumed)
app.get("/join/:code", async (c) => {
  const code = c.req.param("code");
  const accept = c.req.header("accept") ?? "";
  const wantsJson = accept.includes("application/json");

  const { rows } = await pool.query(
    `SELECT j.code, j.agent_slug, j.expires_at, j.consumed_at
       FROM bridge_join_codes j
      WHERE j.code = $1`,
    [code],
  );

  if (rows.length === 0) {
    return wantsJson
      ? c.json({ error: "invalid_code" }, 404)
      : c.html(joinErrorPage("Invalid join code", "This join link does not match any issued code."), 404);
  }
  const row = rows[0]!;
  if (row.consumed_at) {
    return wantsJson
      ? c.json({ error: "already_used", consumed_at: row.consumed_at }, 410)
      : c.html(joinErrorPage("Already used", "This join link has already been consumed. Ask your admin to issue a new one."), 410);
  }
  if (new Date(row.expires_at) < new Date()) {
    return wantsJson
      ? c.json({ error: "expired", expires_at: row.expires_at }, 410)
      : c.html(joinErrorPage("Expired", `This join link expired at ${row.expires_at}. Ask your admin to issue a new one.`), 410);
  }

  return wantsJson
    ? c.json({ slug: row.agent_slug, expires_at: row.expires_at, ready: true })
    : c.html(joinPreviewPage(c.req.url, row.agent_slug, row.expires_at));
});

app.post("/join/:code", async (c) => {
  const code = c.req.param("code");
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT j.code, j.agent_slug, j.expires_at, j.consumed_at,
              a.config, a.kind
         FROM bridge_join_codes j
         JOIN agents a ON a.slug = j.agent_slug
        WHERE j.code = $1
        FOR UPDATE`,
      [code],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return c.json({ error: "invalid_code" }, 404);
    }
    const row = rows[0]!;
    if (row.consumed_at) {
      await client.query("ROLLBACK");
      return c.json({ error: "already_used" }, 410);
    }
    if (new Date(row.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return c.json({ error: "expired" }, 410);
    }

    await client.query(
      `UPDATE bridge_join_codes SET consumed_at = now(), consumed_from = $1 WHERE code = $2`,
      [ip, code],
    );
    await client.query("COMMIT");

    const cfg = row.config as Record<string, unknown>;
    const bridge = (cfg.bridge ?? {}) as Record<string, unknown>;
    const wsUrl = env.NEXUS_PUBLIC_URL.replace(/^http/, "ws") + "/bridge";

    return c.json({
      slug: row.agent_slug,
      server: wsUrl,
      bridge_token: bridge.token,
      config: {
        slug: row.agent_slug,
        display_name: cfg.display_name ?? row.agent_slug,
        description: cfg.description ?? "",
        persona: cfg.system_prompt ?? "",
        cwd: bridge.cwd,
        cli_kind: bridge.cli_kind,
        model: cfg.model ?? "",
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    log.error({ err, code }, "join code consume failed");
    return c.json({ error: "internal" }, 500);
  } finally {
    client.release();
  }
});

function joinPreviewPage(joinUrl: string, slug: string, expiresAt: Date | string): string {
  const expIso = typeof expiresAt === "string" ? expiresAt : expiresAt.toISOString();
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Nexus join</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #222; line-height: 1.5; }
  code { background: #f4f4f4; padding: 0.15em 0.35em; border-radius: 3px; }
  .cmd { background: #1e1e1e; color: #f4f4f4; padding: 1rem; border-radius: 6px; overflow-x: auto; font-family: ui-monospace, monospace; }
  .meta { color: #666; font-size: 0.9em; margin-top: 2rem; }
  .warn { background: #fff4d6; border-left: 4px solid #d6a700; padding: 0.75rem 1rem; border-radius: 4px; margin: 1rem 0; }
</style></head><body>
<h1>Nexus join link</h1>
<p>This link is for connecting <code>${slug}</code> to a Nexus host. Run this on the laptop where the bridge will live:</p>
<div class="cmd">nexus onboard ${joinUrl}</div>
<p>Don't have the CLI yet?</p>
<div class="cmd">curl -fsSL https://kurniarahmattt.github.io/nexus/install.sh | bash</div>
<div class="warn"><strong>One-shot.</strong> The first POST to this URL consumes the code; opening it in a browser does not. After consumption, the link returns 410 Gone.</div>
<p class="meta">Expires: ${expIso}</p>
</body></html>`;
}

function joinErrorPage(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body { font-family: system-ui, sans-serif; max-width: 560px; margin: 4rem auto; padding: 0 1rem; }</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

// ── Bridge invites (admin-issued tokens for self-service bridge creation) ───
// GET  /invite/:code   → preview (HTML or JSON via Accept header), no consume
// POST /invite/:code   → create a new bridge for the requester
//                        Body: { name, cwd, cli, persona?, display_name?, model? }
//                        Returns: { join_url, slug, expires_at }
app.get("/invite/:code", async (c) => {
  const code = c.req.param("code");
  const accept = c.req.header("accept") ?? "";
  const wantsJson = accept.includes("application/json");

  const { rows } = await pool.query(
    `SELECT code, expires_at, max_uses, uses_count, allowed_cli_kinds, slug_prefix
       FROM bridge_invites WHERE code = $1`,
    [code],
  );
  if (rows.length === 0) {
    return wantsJson
      ? c.json({ error: "invalid_code" }, 404)
      : c.html(joinErrorPage("Invalid invite", "This invite code does not exist."), 404);
  }
  const row = rows[0]!;
  if (row.uses_count >= row.max_uses) {
    return wantsJson
      ? c.json({ error: "exhausted", uses_count: row.uses_count, max_uses: row.max_uses }, 410)
      : c.html(joinErrorPage("Invite exhausted", "This invite has been used up. Ask your admin for a new one."), 410);
  }
  if (new Date(row.expires_at) < new Date()) {
    return wantsJson
      ? c.json({ error: "expired", expires_at: row.expires_at }, 410)
      : c.html(joinErrorPage("Expired", `Invite expired at ${row.expires_at}.`), 410);
  }

  const remaining = row.max_uses - row.uses_count;
  return wantsJson
    ? c.json({
        ready: true,
        expires_at: row.expires_at,
        uses_remaining: remaining,
        allowed_cli_kinds: row.allowed_cli_kinds,
        slug_prefix: row.slug_prefix,
      })
    : c.html(invitePreviewPage(c.req.url, row.expires_at, remaining, row.allowed_cli_kinds, row.slug_prefix));
});

const InviteRequestBody = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/).min(1).max(40),
  cwd: z.string().min(1),
  cli: z.string().regex(/^[a-z][a-z-]+$/).min(2).max(20),
  username: z.string().regex(/^[a-z0-9_-]+$/).min(2).max(40),
  persona: z.string().optional(),
  display_name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
});

app.post("/invite/:code", async (c) => {
  const code = c.req.param("code");
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown";

  const parsed = InviteRequestBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }
  const body = parsed.data;
  const slug = `${body.cli}-${body.username}-${body.name}`;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lock + validate the invite.
    const inviteRows = await client.query(
      `SELECT code, expires_at, max_uses, uses_count, allowed_cli_kinds, slug_prefix, allowed_user_id
         FROM bridge_invites WHERE code = $1 FOR UPDATE`,
      [code],
    );
    if (inviteRows.rows.length === 0) {
      await client.query("ROLLBACK");
      return c.json({ error: "invalid_code" }, 404);
    }
    const inv = inviteRows.rows[0];
    if (inv.uses_count >= inv.max_uses) {
      await client.query("ROLLBACK");
      return c.json({ error: "exhausted" }, 410);
    }
    if (new Date(inv.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return c.json({ error: "expired" }, 410);
    }
    if (inv.allowed_cli_kinds && inv.allowed_cli_kinds.length > 0 && !inv.allowed_cli_kinds.includes(body.cli)) {
      await client.query("ROLLBACK");
      return c.json({ error: "cli_not_allowed", allowed: inv.allowed_cli_kinds }, 403);
    }
    if (inv.slug_prefix && !slug.startsWith(inv.slug_prefix)) {
      await client.query("ROLLBACK");
      return c.json({ error: "slug_prefix_mismatch", required_prefix: inv.slug_prefix }, 403);
    }

    // 2. Slug conflict check (idempotency by retrying with the same name fails — admin can change name).
    const conflict = await client.query(`SELECT 1 FROM agents WHERE slug = $1`, [slug]);
    if ((conflict.rowCount ?? 0) > 0) {
      await client.query("ROLLBACK");
      return c.json({ error: "slug_exists", slug }, 409);
    }

    // 3. Resolve / synthesize the user row (the requesting dev needs an `agents.owner_user_id`).
    let userId: string;
    const userRows = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE username = $1`,
      [body.username],
    );
    if (userRows.rowCount && userRows.rowCount > 0) {
      userId = userRows.rows[0]!.id;
    } else {
      const synth = await client.query<{ id: string }>(
        `INSERT INTO users (rocketchat_id, username, display_name)
         VALUES ($1, $2, $3) RETURNING id`,
        [`${body.username}-synth`, body.username, body.username],
      );
      userId = synth.rows[0]!.id;
    }

    // 4. Issue bridge token.
    const bridgeToken = randomBytes(24).toString("hex");

    // 5. Create RC bot user (rcCreateUser uses cached admin creds).
    const display = body.display_name ??
      `${body.cli[0]!.toUpperCase()}${body.cli.slice(1)} (${body.username}-${body.name})`;
    let rcBotId: string;
    let authToken = "";
    let authUserId = "";
    try {
      const botPassword = "nx-" + randomBytes(12).toString("base64url");
      rcBotId = await rcCreateUser({
        username: slug,
        email: `${slug}@nexus.local`,
        name: display,
        password: botPassword,
        roles: ["bot", "user"],
      });
      const botCreds = await rcBotLogin(slug, botPassword);
      authToken = botCreds.token;
      authUserId = botCreds.userId;
    } catch (err) {
      await client.query("ROLLBACK");
      log.warn({ slug, err: String(err) }, "RC bot creation failed during invite consume");
      return c.json({ error: "rc_bot_failed", detail: String(err) }, 502);
    }

    // 6. Insert agents row.
    const persona = body.persona ??
      `You are @${slug}, a Nexus bridge bot owned by ${body.username}, wrapping ${body.cli} on their machine in ${body.cwd}. Be concise. Match the user's language. Watch [TEAM CONTEXT] for attribution.`;
    await client.query(
      `INSERT INTO agents (slug, display_name, cli_command, cli_args, rocketchat_username,
                           rocketchat_bot_id, kind, owner_user_id, config, enabled)
       VALUES ($1, $2, $3, '[]'::jsonb, $1, $4, 'remote', $5, $6::jsonb, true)`,
      [
        slug,
        display,
        body.cli,
        rcBotId,
        userId,
        JSON.stringify({
          system_prompt: persona,
          description: body.description ?? "",
          model: body.model ?? "",
          auth_token: authToken,
          auth_user_id: authUserId,
          bridge: { token: bridgeToken, cli_kind: body.cli, cwd: body.cwd },
        }),
      ],
    );

    // 7. Issue a one-shot join code so the requester can immediately onboard.
    const joinCode = randomBytes(20).toString("base64url");
    const joinExpires = new Date(Date.now() + env.NEXUS_JOIN_TTL_HOURS * 3600_000);
    await client.query(
      `INSERT INTO bridge_join_codes (code, agent_slug, issued_by, expires_at)
         VALUES ($1, $2, $3, $4)`,
      [joinCode, slug, userId, joinExpires],
    );

    // 8. Mark invite usage.
    await client.query(
      `UPDATE bridge_invites SET uses_count = uses_count + 1 WHERE code = $1`,
      [code],
    );
    await client.query(
      `INSERT INTO bridge_invite_uses (invite_code, consumed_from, resulting_slug, consumed_by)
         VALUES ($1, $2, $3, $4)`,
      [code, ip, slug, userId],
    );

    await client.query("COMMIT");

    const joinUrl = `${env.NEXUS_PUBLIC_URL}/join/${joinCode}`;
    return c.json({
      ok: true,
      slug,
      join_url: joinUrl,
      join_expires_at: joinExpires.toISOString(),
    });
  } catch (err) {
    await client.query("ROLLBACK");
    log.error({ err, code }, "invite consume failed");
    return c.json({ error: "internal" }, 500);
  } finally {
    client.release();
  }
});

function invitePreviewPage(
  inviteUrl: string,
  expiresAt: Date | string,
  remaining: number,
  allowedClis: string[] | null | undefined,
  slugPrefix: string | null | undefined,
): string {
  const expIso = typeof expiresAt === "string" ? expiresAt : expiresAt.toISOString();
  const cliText = allowedClis && allowedClis.length > 0 ? allowedClis.join(", ") : "any";
  const prefixText = slugPrefix ? `<li>slug must start with <code>${slugPrefix}</code></li>` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Nexus invite</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; color: #222; line-height: 1.5; }
  code { background: #f4f4f4; padding: 0.15em 0.35em; border-radius: 3px; }
  .cmd { background: #1e1e1e; color: #f4f4f4; padding: 1rem; border-radius: 6px; overflow-x: auto; font-family: ui-monospace, monospace; }
  .meta { color: #666; font-size: 0.9em; margin-top: 2rem; }
  ul { color: #666; font-size: 0.9em; }
</style></head><body>
<h1>Nexus invite</h1>
<p>This invite lets you create a new bridge bot for yourself. Run on the laptop where the bridge will live:</p>
<div class="cmd">nexus request-bridge ${inviteUrl} \\
  --name &lt;role&gt; \\
  --cwd /path/on/your/laptop</div>
<p>Don't have the CLI yet?</p>
<div class="cmd">curl -fsSL https://kurniarahmattt.github.io/nexus/install.sh | bash</div>
<p>Constraints:</p>
<ul>
  <li>allowed CLIs: <code>${cliText}</code></li>
  ${prefixText}
  <li>uses remaining: ${remaining}</li>
  <li>expires: ${expIso}</li>
</ul>
</body></html>`;
}

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
      triggerKind: "user",
      text: cleaned,
      rawText: data.combinedText,
      triggeredAt: data.firstTs,
      hop: 0,
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
  fetch(req: Request, server: import("bun").Server<unknown>) {
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
