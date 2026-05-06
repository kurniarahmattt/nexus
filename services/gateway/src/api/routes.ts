/**
 * REST API for the Nexus Web UI. Mounted under /api.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { pool } from "../db.ts";
import { env } from "../env.ts";
import {
  readSession,
  requireAdmin,
  requireSession,
  writeSession,
  clearSession,
  type SessionPayload,
} from "./session.ts";
import {
  createUser as rcCreateUser,
  userInfo as rcUserInfo,
  updateUser as rcUpdateUser,
  createRoom as rcCreateRoom,
  inviteToRoom as rcInviteToRoom,
  addTriggerWord,
  clear2FA,
  botLogin,
  rocketchatRidsForUser,
} from "./rc.ts";
import { isBridgeConnected } from "../bridge.ts";

const r = new Hono();

// Allow the Vite dev server to hit the gateway directly.
r.use(
  "/*",
  cors({
    origin: env.NEXUS_WEB_ORIGIN,
    credentials: true,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

function randomToken(): string {
  return randomBytes(24).toString("hex");
}

function randomPassword(): string {
  return "nx-" + randomBytes(9).toString("base64url");
}

// ─── Auth ───────────────────────────────────────────────────────────────
const LoginBody = z.object({ token: z.string().min(16) });

r.post("/auth/login", async (c) => {
  const parsed = LoginBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  // Bootstrap admin: if NEXUS_ADMIN_TOKEN env matches AND admin row has
  // no token yet, seed it. Scope to role='admin' so we don't collide with
  // RC-autoingested username='admin' rows from legacy webhook ingestion.
  if (env.NEXUS_ADMIN_TOKEN && parsed.data.token === env.NEXUS_ADMIN_TOKEN) {
    await pool.query(
      `UPDATE users SET auth_token = $1
         WHERE role = 'admin' AND auth_token IS NULL`,
      [parsed.data.token],
    );
  }

  const { rows } = await pool.query<{
    id: string;
    username: string;
    role: "admin" | "user";
  }>(
    `SELECT id, username, role FROM users WHERE auth_token = $1 LIMIT 1`,
    [parsed.data.token],
  );
  const user = rows[0];
  if (!user) return c.json({ error: "invalid_token" }, 401);

  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  writeSession(c, user);
  return c.json({ ok: true, user });
});

r.post("/auth/logout", async (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

r.get("/auth/me", async (c) => {
  const session = await readSession(c);
  if (!session) return c.json({ user: null });
  const { rows } = await pool.query<{
    id: string;
    username: string;
    display_name: string | null;
    role: "admin" | "user";
  }>(
    `SELECT id, username, display_name, role FROM users WHERE id = $1 LIMIT 1`,
    [session.userId],
  );
  return c.json({ user: rows[0] ?? null });
});

// ─── Admin: Users ───────────────────────────────────────────────────────
const CreateUserBody = z.object({
  username: z.string().min(2).regex(/^[a-z0-9_-]+$/),
  display_name: z.string().min(1),
});

r.get("/admin/users", requireAdmin, async (c) => {
  const { rows } = await pool.query(
    `SELECT id, username, display_name, email, role, nexus_created,
            last_login_at, created_at
       FROM users
       WHERE nexus_created = true OR role = 'admin'
       ORDER BY role DESC, created_at ASC`,
  );
  return c.json({ users: rows });
});

r.post("/admin/users", requireAdmin, async (c) => {
  const parsed = CreateUserBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const { username, display_name } = parsed.data;

  // Check existing. Only block if the row is already a Nexus-managed user
  // or admin; a legacy webhook-ingested row (nexus_created=false, role=user)
  // is safe to *promote* into a real Nexus user without losing references.
  const { rows: existingRows } = await pool.query<{
    id: string;
    nexus_created: boolean;
    role: "admin" | "user";
  }>(`SELECT id, nexus_created, role FROM users WHERE username = $1 LIMIT 1`, [
    username,
  ]);
  const existing = existingRows[0];
  if (existing && (existing.nexus_created || existing.role === "admin")) {
    return c.json({ error: "username_exists" }, 409);
  }

  const password = randomPassword();
  const token = randomToken();
  const email = `${username}@nexus.local`;

  // Create in RC; if user already exists, reset its password + activate.
  let rcId: string;
  try {
    rcId = await rcCreateUser({ username, email, name: display_name, password });
    await clear2FA(username);
  } catch (err) {
    const info = await rcUserInfo(username);
    if (!info) {
      return c.json({ error: "rc_create_failed", detail: (err as Error).message }, 500);
    }
    rcId = info._id;
    try {
      await rcUpdateUser({
        userId: rcId,
        name: display_name,
        password,
        active: true,
        verified: true,
      });
      await clear2FA(username);
    } catch (e2) {
      return c.json({ error: "rc_update_failed", detail: (e2 as Error).message }, 500);
    }
  }

  if (existing) {
    // Promote legacy row in-place so we don't orphan any FK references.
    await pool.query(
      `UPDATE users SET
         rocketchat_id = $1,
         display_name = $2,
         email = $3,
         rocketchat_password = $4,
         auth_token = $5,
         nexus_created = true,
         role = 'user',
         updated_at = now()
       WHERE id = $6`,
      [rcId, display_name, email, password, token, existing.id],
    );
    return c.json({
      user: {
        id: existing.id,
        username,
        role: "user",
        promoted_from_legacy: true,
      },
      credentials: { auth_token: token, rc_password: password },
    });
  }

  const { rows } = await pool.query<{
    id: string;
    username: string;
    role: "admin" | "user";
  }>(
    `INSERT INTO users (rocketchat_id, username, display_name, email,
                        rocketchat_password, auth_token,
                        nexus_created, role)
     VALUES ($1,$2,$3,$4,$5,$6,true,'user')
     RETURNING id, username, role`,
    [rcId, username, display_name, email, password, token],
  );
  return c.json({ user: rows[0], credentials: { auth_token: token, rc_password: password } });
});

// ─── Admin: MCP Servers ─────────────────────────────────────────────────
const McpBody = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(50),
  display_name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  description: z.string().default(""),
  enabled: z.boolean().default(false),
});
const McpPatchBody = McpBody.partial().omit({ slug: true });

r.get("/admin/mcp-servers", requireAdmin, async (c) => {
  const { rows } = await pool.query(
    `SELECT id, slug, display_name, command, args, env, description, enabled, created_at
       FROM mcp_servers ORDER BY slug`,
  );
  return c.json({ servers: rows });
});

r.post("/admin/mcp-servers", requireAdmin, async (c) => {
  const parsed = McpBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  const { slug, display_name, command, args, env, description, enabled } = parsed.data;
  try {
    const { rows } = await pool.query(
      `INSERT INTO mcp_servers (slug, display_name, command, args, env, description, enabled)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
       RETURNING id, slug, enabled`,
      [slug, display_name, command, JSON.stringify(args), JSON.stringify(env), description, enabled],
    );
    return c.json({ server: rows[0] });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("duplicate key")) return c.json({ error: "slug_exists" }, 409);
    return c.json({ error: "insert_failed", detail: msg }, 500);
  }
});

r.patch("/admin/mcp-servers/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const parsed = McpPatchBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);
  const p = parsed.data;
  const updates: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    if (k === "args" || k === "env") {
      updates.push(`${k} = $${i++}::jsonb`);
      params.push(JSON.stringify(v));
    } else {
      updates.push(`${k} = $${i++}`);
      params.push(v);
    }
  }
  if (updates.length === 0) return c.json({ ok: true, updated: 0 });
  params.push(id);
  await pool.query(
    `UPDATE mcp_servers SET ${updates.join(", ")} WHERE id = $${i}`,
    params,
  );
  return c.json({ ok: true, updated: updates.length });
});

r.delete("/admin/mcp-servers/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  await pool.query(`DELETE FROM mcp_servers WHERE id = $1`, [id]);
  return c.json({ ok: true });
});

r.get("/admin/users/:id/credentials", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const { rows } = await pool.query<{
    auth_token: string | null;
    rocketchat_password: string | null;
    username: string;
  }>(
    `SELECT auth_token, rocketchat_password, username FROM users WHERE id = $1`,
    [id],
  );
  const u = rows[0];
  if (!u) return c.json({ error: "not_found" }, 404);
  return c.json({
    username: u.username,
    rocketchat_username: u.username,
    auth_token: u.auth_token,
    rc_password: u.rocketchat_password,
  });
});

// ─── Me: profile + bridges ──────────────────────────────────────────────
r.get("/me", requireSession, async (c) => {
  const session = c.get("session") as SessionPayload;
  const { rows } = await pool.query(
    `SELECT id, username, display_name, role, email FROM users WHERE id = $1`,
    [session.userId],
  );
  return c.json({ user: rows[0] });
});

const PatchMeBody = z.object({
  display_name: z.string().min(1).max(60).optional(),
  username: z.string().regex(/^[a-z0-9_-]{2,}$/).max(30).optional(),
});

r.patch("/me", requireSession, async (c) => {
  const session = c.get("session") as SessionPayload;
  const parsed = PatchMeBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  }
  const { display_name, username } = parsed.data;
  if (!display_name && !username) {
    return c.json({ error: "nothing_to_update" }, 400);
  }

  // Load current row to get RC user id + detect no-op.
  const { rows: curRows } = await pool.query<{
    id: string;
    username: string;
    display_name: string | null;
    rocketchat_id: string;
  }>(
    `SELECT id, username, display_name, rocketchat_id FROM users WHERE id = $1`,
    [session.userId],
  );
  const cur = curRows[0];
  if (!cur) return c.json({ error: "not_found" }, 404);

  // Uniqueness check for username.
  if (username && username !== cur.username) {
    const dup = await pool.query(
      `SELECT 1 FROM users WHERE username = $1 AND id <> $2`,
      [username, session.userId],
    );
    if (dup.rowCount !== null && dup.rowCount > 0) {
      return c.json({ error: "username_exists" }, 409);
    }
  }

  // Push to RC (update name and/or username).
  try {
    await rcUpdateUser({
      userId: cur.rocketchat_id,
      name: display_name,
      username,
    });
  } catch (err) {
    return c.json({ error: "rc_update_failed", detail: (err as Error).message }, 500);
  }

  // Update Nexus users table.
  const updates: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (display_name !== undefined) {
    updates.push(`display_name = $${i++}`);
    params.push(display_name);
  }
  if (username !== undefined) {
    updates.push(`username = $${i++}`);
    params.push(username);
  }
  params.push(session.userId);
  await pool.query(
    `UPDATE users SET ${updates.join(", ")}, updated_at = now() WHERE id = $${i}`,
    params,
  );

  // Refresh session cookie if username changed (session.username is stale).
  if (username && username !== cur.username) {
    writeSession(c, {
      id: session.userId,
      role: session.role,
      username,
    });
  }

  return c.json({
    ok: true,
    user: {
      id: session.userId,
      username: username ?? cur.username,
      display_name: display_name ?? cur.display_name,
      role: session.role,
    },
  });
});

r.get("/me/bridges", requireSession, async (c) => {
  const session = c.get("session") as SessionPayload;
  const filter =
    session.role === "admin"
      ? `kind = 'remote'`
      : `kind = 'remote' AND owner_user_id = $1`;
  const params = session.role === "admin" ? [] : [session.userId];
  const { rows } = await pool.query<{
    slug: string;
    display_name: string;
    description: string | null;
    cli_kind: string | null;
    cwd: string | null;
    model: string | null;
    persona: string | null;
    last_connected_at: Date | null;
    enabled: boolean;
    rocketchat_username: string;
  }>(
    `SELECT slug, display_name, config->>'description' AS description,
            config->'bridge'->>'cli_kind' AS cli_kind,
            config->'bridge'->>'cwd' AS cwd,
            config->>'model' AS model,
            config->>'system_prompt' AS persona,
            last_connected_at, enabled, rocketchat_username
       FROM agents
       WHERE ${filter}
       ORDER BY slug`,
    params,
  );
  // Live connection status comes from the in-memory WS session map,
  // not from last_connected_at (which is historical).
  const bridges = rows.map((r) => ({
    ...r,
    is_connected: isBridgeConnected(r.slug),
  }));
  return c.json({ bridges });
});

const CreateBridgeBody = z.object({
  cli: z.enum(["claude", "hermes", "cursor", "gemini"]),
  cwd: z.string().min(1),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  display_name: z.string().min(1).optional(),
  description: z.string().optional(),
  persona: z.string().optional(),
  model: z.string().optional(),
});

r.post("/me/bridges", requireSession, async (c) => {
  const session = c.get("session") as SessionPayload;
  const parsed = CreateBridgeBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  const { cli, cwd, name, display_name, description, persona, model } = parsed.data;

  const slug = name ? `${cli}-${session.username}-${name}` : `${cli}-${session.username}`;

  const exists = await pool.query(`SELECT 1 FROM agents WHERE slug = $1`, [slug]);
  if (exists.rowCount !== null && exists.rowCount > 0) {
    return c.json({ error: "slug_exists", slug }, 409);
  }

  // Create RC bot user. Password is random per-bot — only used at this
  // creation step to capture authToken via /api/v1/login (line below).
  // After that, the authToken is what's persisted and reused; the password
  // is discarded and never stored in our DB.
  const botPassword = randomPassword();
  const email = `${slug}@nexus.local`;
  const botDisplay = display_name ?? `${cli[0]!.toUpperCase()}${cli.slice(1)} (${session.username}${name ? "-" + name : ""})`;
  let rcBotId: string;
  try {
    rcBotId = await rcCreateUser({
      username: slug,
      email,
      name: botDisplay,
      password: botPassword,
      roles: ["bot", "user"],
    });
    await clear2FA(slug);
  } catch (err) {
    // If user already exists, fetch its id.
    const info = await rcUserInfo(slug);
    if (!info) return c.json({ error: "rc_bot_failed", detail: (err as Error).message }, 500);
    rcBotId = info._id;
  }

  // Login bot to capture auth_token.
  let authToken: string, authUserId: string;
  try {
    const creds = await botLogin(slug, botPassword);
    authToken = creds.token;
    authUserId = creds.userId;
  } catch (err) {
    return c.json({ error: "bot_login_failed", detail: (err as Error).message }, 500);
  }

  const bridgeToken = randomToken();
  const effectivePersona =
    persona ??
    `You are @${slug}, a Claude Code session owned by ${session.username}, running on their PC in ${cwd}.\n\nBe concise. Match user's language. The chat is multi-user; watch [TEAM CONTEXT] for attribution.`;

  await pool.query(
    `INSERT INTO agents
       (slug, display_name, cli_command, cli_args, rocketchat_username,
        rocketchat_bot_id, kind, owner_user_id, config, enabled)
     VALUES ($1, $2, $3, '[]'::jsonb, $1, $4, 'remote', $5, $6::jsonb, true)`,
    [
      slug,
      botDisplay,
      cli,
      rcBotId,
      session.userId,
      JSON.stringify({
        system_prompt: effectivePersona,
        description: description ?? "",
        model: model ?? "",
        auth_token: authToken,
        auth_user_id: authUserId,
        bridge: { token: bridgeToken, cli_kind: cli, cwd },
      }),
    ],
  );

  await addTriggerWord(slug);

  return c.json({
    slug,
    bridge_token: bridgeToken,
    config: {
      display_name: botDisplay,
      description: description ?? "",
      persona: effectivePersona,
      model: model ?? "",
      cwd,
    },
  });
});

const PatchBridgeBody = z.object({
  display_name: z.string().min(1).optional(),
  description: z.string().optional(),
  persona: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
});

r.patch("/me/bridges/:slug", requireSession, async (c) => {
  const session = c.get("session") as SessionPayload;
  const slug = c.req.param("slug");
  const parsed = PatchBridgeBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const { rows: check } = await pool.query<{ owner_user_id: string | null }>(
    `SELECT owner_user_id FROM agents WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  if (!check[0]) return c.json({ error: "not_found" }, 404);
  if (session.role !== "admin" && check[0].owner_user_id !== session.userId) {
    return c.json({ error: "forbidden" }, 403);
  }

  const patch: Record<string, unknown> = {};
  if (parsed.data.persona !== undefined)     patch.system_prompt = parsed.data.persona;
  if (parsed.data.description !== undefined) patch.description  = parsed.data.description;
  if (parsed.data.model !== undefined)       patch.model        = parsed.data.model;
  const bridgePatch: Record<string, unknown> = {};
  if (parsed.data.cwd !== undefined) bridgePatch.cwd = parsed.data.cwd;

  // Build a SINGLE `config = ...` expression that may merge both the
  // top-level patch and the nested bridge patch. Postgres rejects two
  // assignments to the same column in one UPDATE.
  const updates: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  const hasTop = Object.keys(patch).length > 0;
  const hasBridge = Object.keys(bridgePatch).length > 0;

  if (hasTop && hasBridge) {
    updates.push(
      `config = (config || $${i}::jsonb) || jsonb_build_object('bridge', (config->'bridge') || $${i + 1}::jsonb)`,
    );
    params.push(JSON.stringify(patch));
    params.push(JSON.stringify(bridgePatch));
    i += 2;
  } else if (hasTop) {
    updates.push(`config = config || $${i}::jsonb`);
    params.push(JSON.stringify(patch));
    i += 1;
  } else if (hasBridge) {
    updates.push(
      `config = jsonb_set(config, '{bridge}', (config->'bridge') || $${i}::jsonb)`,
    );
    params.push(JSON.stringify(bridgePatch));
    i += 1;
  }

  if (parsed.data.display_name) {
    updates.push(`display_name = $${i++}`);
    params.push(parsed.data.display_name);
  }
  if (updates.length === 0) return c.json({ ok: true, updated: 0 });
  params.push(slug);
  updates.push(`updated_at = now()`);
  await pool.query(`UPDATE agents SET ${updates.join(", ")} WHERE slug = $${i}`, params);
  return c.json({ ok: true, updated: updates.length });
});

r.get("/me/bridges/:slug/config", requireSession, async (c) => {
  const session = c.get("session") as SessionPayload;
  const slug = c.req.param("slug");
  const { rows } = await pool.query<{
    owner_user_id: string | null;
    display_name: string;
    config: Record<string, unknown>;
  }>(
    `SELECT owner_user_id, display_name, config FROM agents WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  if (session.role !== "admin" && rows[0].owner_user_id !== session.userId) {
    return c.json({ error: "forbidden" }, 403);
  }
  const cfg = rows[0].config as {
    system_prompt?: string;
    description?: string;
    model?: string;
    bridge?: { cli_kind: string; cwd: string; token: string };
  };
  return c.json({
    slug,
    display_name: rows[0].display_name,
    description: cfg.description ?? "",
    persona: cfg.system_prompt ?? "",
    model: cfg.model ?? "",
    cwd: cfg.bridge?.cwd ?? "",
    cli: cfg.bridge?.cli_kind ?? "claude",
    bridge_token: cfg.bridge?.token ?? "",
    download: {
      display_name: rows[0].display_name,
      description: cfg.description ?? "",
      persona: cfg.system_prompt ?? "",
      model: cfg.model ?? "",
      cwd: cfg.bridge?.cwd ?? "",
    },
  });
});

// ─── Channels ───────────────────────────────────────────────────────────
const CreateChannelBody = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(50),
  kind: z.enum(["channel", "private"]).default("channel"),
  members: z.array(z.string()).default([]),
});

r.get("/channels/search-members", requireSession, async (c) => {
  const session = c.get("session") as SessionPayload;
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const like = `%${q}%`;

  // Humans: everyone in the Nexus workspace directory.
  const { rows: humans } = await pool.query<{ username: string; display_name: string | null }>(
    `SELECT username, display_name FROM users
      WHERE (username ILIKE $1 OR display_name ILIKE $1)
        AND nexus_created = true
      ORDER BY username LIMIT 20`,
    [like],
  );

  // Bots: shared (workspace-global) + remote bots the requester owns.
  // Admin sees all.
  const botQuery =
    session.role === "admin"
      ? `SELECT slug, display_name, kind FROM agents
          WHERE enabled = true AND (slug ILIKE $1 OR display_name ILIKE $1)
          ORDER BY slug LIMIT 20`
      : `SELECT slug, display_name, kind FROM agents
          WHERE enabled = true
            AND (slug ILIKE $1 OR display_name ILIKE $1)
            AND (kind = 'shared' OR owner_user_id = $2)
          ORDER BY slug LIMIT 20`;
  const botParams =
    session.role === "admin" ? [like] : [like, session.userId];
  const { rows: bots } = await pool.query<{
    slug: string;
    display_name: string;
    kind: string;
  }>(botQuery, botParams);

  return c.json({
    humans: humans.map((h) => ({ username: h.username, display_name: h.display_name, kind: "human" })),
    bots: bots.map((b) => ({ username: b.slug, display_name: b.display_name, kind: `bot:${b.kind}` })),
  });
});

r.post("/channels", requireSession, async (c) => {
  const session = c.get("session") as SessionPayload;
  const parsed = CreateChannelBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  const { name, kind, members } = parsed.data;

  try {
    const rcRoom = await rcCreateRoom({
      name,
      kind,
      members: [...new Set([session.username, ...members])],
    });
    await pool.query(
      `INSERT INTO rooms (rocketchat_rid, kind, name) VALUES ($1, $2, $3)
       ON CONFLICT (rocketchat_rid) DO NOTHING`,
      [rcRoom._id, kind, name],
    );
    return c.json({ ok: true, rocketchat_rid: rcRoom._id, name: rcRoom.name, kind });
  } catch (err) {
    return c.json({ error: "create_failed", detail: (err as Error).message }, 500);
  }
});

const InviteBody = z.object({
  usernames: z.array(z.string().min(1)).min(1),
});

r.post("/channels/:rid/invite", requireSession, async (c) => {
  const session = c.get("session") as SessionPayload;
  const rid = c.req.param("rid");
  const parsed = InviteBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const { rows } = await pool.query<{ name: string | null; kind: string }>(
    `SELECT name, kind FROM rooms WHERE rocketchat_rid = $1 LIMIT 1`,
    [rid],
  );
  const room = rows[0];
  if (!room?.name) return c.json({ error: "room_not_found" }, 404);

  // Non-admin users must be a member of the target channel.
  if (session.role !== "admin") {
    const { rows: uRows } = await pool.query<{ rocketchat_id: string }>(
      `SELECT rocketchat_id FROM users WHERE id = $1`,
      [session.userId],
    );
    const rcId = uRows[0]?.rocketchat_id;
    if (!rcId) return c.json({ error: "not_a_member" }, 403);
    const myRids = await rocketchatRidsForUser(rcId);
    if (!myRids.includes(rid)) return c.json({ error: "not_a_member" }, 403);
  }

  const results: Record<string, boolean> = {};
  for (const u of parsed.data.usernames) {
    results[u] = await rcInviteToRoom({
      roomName: room.name,
      username: u,
      kind: room.kind === "private" ? "private" : "channel",
    });
  }
  return c.json({ ok: true, results });
});

r.get("/channels", requireSession, async (c) => {
  const session = c.get("session") as SessionPayload;
  // Admin sees everything. Users see channels they subscribe to in RC.
  if (session.role === "admin") {
    const { rows } = await pool.query(
      `SELECT id, rocketchat_rid, kind, name, created_at FROM rooms ORDER BY created_at DESC`,
    );
    return c.json({ channels: rows });
  }
  // Find the user's RC id.
  const { rows: userRows } = await pool.query<{ rocketchat_id: string }>(
    `SELECT rocketchat_id FROM users WHERE id = $1`,
    [session.userId],
  );
  const rcId = userRows[0]?.rocketchat_id;
  if (!rcId) return c.json({ channels: [] });

  const rids = await rocketchatRidsForUser(rcId);
  if (rids.length === 0) return c.json({ channels: [] });
  const { rows } = await pool.query(
    `SELECT id, rocketchat_rid, kind, name, created_at FROM rooms
      WHERE rocketchat_rid = ANY($1::text[])
      ORDER BY created_at DESC`,
    [rids],
  );
  return c.json({ channels: rows });
});

export default r;
