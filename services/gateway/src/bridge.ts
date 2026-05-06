/**
 * Phase 6A — Bridge hub.
 *
 * Upgrades /bridge WS connections from nexus-bridge clients.
 * Authenticates by `config.bridge.token` in agents table.
 * Keeps in-memory Map<slug, ServerWebSocket> of active bridges.
 *
 * Exposes HTTP POST /internal/bridge/dispatch for the runtime service to
 * send invoke jobs. Each call has a jobId; gateway forwards the invoke
 * frame over WS, buffers chunks (Phase 6A ignores them), and awaits the
 * matching `result` frame before responding to the runtime's HTTP call.
 */

import type { ServerWebSocket } from "bun";
import pino from "pino";
import {
  BridgeClientFrame,
  BridgeDispatchRequest,
  type BridgeDispatchResponse,
  type BridgeServerFrame,
} from "@nexus/schema";
import { pool } from "./db.ts";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

interface BridgeSession {
  slug: string;
  ws: ServerWebSocket<BridgeSocketData>;
  cliKind: string;
  cwd: string;
}

interface BridgeSocketData {
  slug: string | null;
}

// slug → active session
const sessions = new Map<string, BridgeSession>();

// jobId → resolver for pending dispatches
interface Pending {
  resolve: (r: BridgeDispatchResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pending = new Map<string, Pending>();

function sendFrame(ws: ServerWebSocket<BridgeSocketData>, frame: BridgeServerFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch (err) {
    log.warn({ err: String(err) }, "bridge send failed");
  }
}

async function authenticate(token: string): Promise<{
  slug: string;
  cli_kind: string;
  cwd: string;
} | null> {
  const { rows } = await pool.query<{
    slug: string;
    cli_kind: string;
    cwd: string;
  }>(
    `SELECT slug,
            config->'bridge'->>'cli_kind' AS cli_kind,
            config->'bridge'->>'cwd'      AS cwd
       FROM agents
      WHERE kind = 'remote'
        AND config->'bridge'->>'token' = $1
        AND enabled = true
      LIMIT 1`,
    [token],
  );
  return rows[0] ?? null;
}

async function markConnected(slug: string): Promise<void> {
  await pool
    .query(`UPDATE agents SET last_connected_at = now() WHERE slug = $1`, [slug])
    .catch((err) => log.warn({ err: String(err) }, "markConnected failed"));
}

/**
 * Apply identity fields sent by the bridge — CREATE-ONLY semantics.
 *
 * Bridge identity is meant for initial bootstrap: if a field is already
 * set in the DB (typically by the Admin UI or by an earlier bridge
 * connect), we do NOT overwrite. This makes Admin UI edits authoritative.
 * To re-allow a bridge to set a field, clear it via the UI first.
 *
 * Session-scoped fields (cwd_override) stay in the in-memory session,
 * not handled here.
 */
async function applyIdentity(
  slug: string,
  identity: {
    display_name?: string;
    persona?: string;
    description?: string;
    model?: string;
  },
): Promise<void> {
  const { rows } = await pool.query<{
    config: {
      system_prompt?: string;
      description?: string;
      model?: string;
    };
    display_name: string | null;
  }>(`SELECT config, display_name FROM agents WHERE slug = $1`, [slug]);
  const row = rows[0];
  if (!row) return;

  const cfg = row.config ?? {};
  const configPatch: Record<string, unknown> = {};
  if (identity.persona && !cfg.system_prompt)     configPatch.system_prompt = identity.persona;
  if (identity.description && !cfg.description)   configPatch.description   = identity.description;
  if (identity.model && !cfg.model)               configPatch.model         = identity.model;

  const updates: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (Object.keys(configPatch).length) {
    updates.push(`config = config || $${i++}::jsonb`);
    params.push(JSON.stringify(configPatch));
  }
  if (identity.display_name && !row.display_name) {
    updates.push(`display_name = $${i++}`);
    params.push(identity.display_name);
  }
  if (updates.length === 0) return;

  params.push(slug);
  updates.push(`updated_at = now()`);
  await pool
    .query(
      `UPDATE agents SET ${updates.join(", ")} WHERE slug = $${i}`,
      params,
    )
    .catch((err) => log.warn({ err: String(err) }, "applyIdentity failed"));
}

// ── WS handlers installed by gateway index.ts ──────────────────────────

export const bridgeWSHandler = {
  open(ws: ServerWebSocket<BridgeSocketData>) {
    log.info("bridge ws opened (awaiting hello)");
  },

  async message(
    ws: ServerWebSocket<BridgeSocketData>,
    raw: string | Buffer,
  ) {
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const parsed = BridgeClientFrame.safeParse(msg);
    if (!parsed.success) {
      log.warn({ issues: parsed.error.issues }, "bridge frame invalid");
      return;
    }
    const frame = parsed.data;

    if (frame.type === "hello") {
      const auth = await authenticate(frame.token);
      if (!auth) {
        sendFrame(ws, { type: "auth_fail", reason: "unknown_token" });
        ws.close(1008, "auth_fail");
        return;
      }
      // Replace any existing session for this slug.
      const prev = sessions.get(auth.slug);
      if (prev) {
        prev.ws.close(1000, "replaced_by_new_bridge");
      }
      ws.data.slug = auth.slug;
      const effectiveCwd = frame.identity?.cwd_override ?? auth.cwd;
      sessions.set(auth.slug, {
        slug: auth.slug,
        ws,
        cliKind: auth.cli_kind,
        cwd: effectiveCwd,
      });
      await markConnected(auth.slug);
      if (frame.identity) {
        await applyIdentity(auth.slug, frame.identity);
      }
      sendFrame(ws, {
        type: "welcome",
        slug: auth.slug,
        cli_kind: auth.cli_kind,
        cwd: effectiveCwd,
      });
      log.info(
        {
          slug: auth.slug,
          cli: auth.cli_kind,
          cwd: effectiveCwd,
          identitySet: !!frame.identity,
        },
        "bridge authenticated",
      );
      return;
    }

    if (frame.type === "pong") return; // heartbeat, ignore

    if (frame.type === "chunk") {
      // Phase 6A: chunks arrive but we don't stream back to chat yet.
      // Reserved for future streaming. Drop silently.
      return;
    }

    if (frame.type === "result") {
      const p = pending.get(frame.jobId);
      if (!p) {
        log.warn({ jobId: frame.jobId }, "bridge result for unknown jobId");
        return;
      }
      clearTimeout(p.timer);
      pending.delete(frame.jobId);
      const resp: BridgeDispatchResponse = {
        ok: frame.ok,
        output: frame.output,
        ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {}),
        ...(frame.exitCode !== undefined ? { exitCode: frame.exitCode } : {}),
        ...(frame.errorText !== undefined ? { errorText: frame.errorText } : {}),
      };
      p.resolve(resp);
    }
  },

  close(ws: ServerWebSocket<BridgeSocketData>) {
    const slug = ws.data.slug;
    if (slug) {
      const session = sessions.get(slug);
      if (session && session.ws === ws) {
        sessions.delete(slug);
        log.info({ slug }, "bridge disconnected");
      }
    }
  },
};

// ── HTTP dispatch handler called by runtime ────────────────────────────
export async function handleDispatch(body: unknown): Promise<BridgeDispatchResponse> {
  const parsed = BridgeDispatchRequest.safeParse(body);
  if (!parsed.success) {
    return { ok: false, output: "", errorText: "invalid_dispatch_request" };
  }
  const req = parsed.data;
  const session = sessions.get(req.slug);
  if (!session) {
    return {
      ok: false,
      output: "",
      errorText: `bridge '${req.slug}' not connected`,
    };
  }
  return new Promise<BridgeDispatchResponse>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(req.jobId);
      resolve({
        ok: false,
        output: "",
        errorText: `bridge timeout after ${req.timeoutMs}ms`,
      });
    }, req.timeoutMs + 5_000);

    pending.set(req.jobId, {
      resolve,
      reject: (err) =>
        resolve({ ok: false, output: "", errorText: err.message }),
      timer,
    });

    sendFrame(session.ws, {
      type: "invoke",
      jobId: req.jobId,
      systemPrompt: req.systemPrompt,
      userPrompt: req.userPrompt,
      workingDirectory: req.workingDirectory,
      timeoutMs: req.timeoutMs,
      ...(req.mcpConfig ? { mcpConfig: req.mcpConfig } : {}),
    });
  });
}

export function bridgeStatus(): Array<{ slug: string; cli: string; cwd: string }> {
  return [...sessions.values()].map((s) => ({
    slug: s.slug,
    cli: s.cliKind,
    cwd: s.cwd,
  }));
}

/** Is a given remote bridge currently connected (live WS)? */
export function isBridgeConnected(slug: string): boolean {
  return sessions.has(slug);
}
