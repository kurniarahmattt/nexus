/**
 * Session cookie — HMAC-signed JSON blob. Dev-grade; fine because all
 * endpoints live on localhost gateway and secret is env-configured.
 * Payload: { userId, role, username, exp }.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { pool } from "../db.ts";
import { env } from "../env.ts";

const COOKIE_NAME = "nexus_session";
const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

export interface SessionPayload {
  userId: string;
  role: "admin" | "user";
  username: string;
  exp: number; // unix seconds
}

function b64urlEncode(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString("base64url");
}

function sign(payload: SessionPayload): string {
  const body = b64urlEncode(JSON.stringify(payload));
  const mac = createHmac("sha256", env.NEXUS_SESSION_SECRET).update(body).digest();
  return `${body}.${b64urlEncode(mac)}`;
}

function verify(cookie: string): SessionPayload | null {
  const parts = cookie.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = createHmac("sha256", env.NEXUS_SESSION_SECRET).update(body).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function writeSession(c: Context, user: { id: string; role: "admin" | "user"; username: string }): void {
  const payload: SessionPayload = {
    userId: user.id,
    role: user.role,
    username: user.username,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
  };
  setCookie(c, COOKIE_NAME, sign(payload), {
    httpOnly: true,
    sameSite: "Lax",
    secure: false,
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export async function readSession(c: Context): Promise<SessionPayload | null> {
  const cookie = getCookie(c, COOKIE_NAME);
  if (!cookie) return null;
  const payload = verify(cookie);
  if (!payload) return null;
  // Verify user still exists + role matches.
  const { rows } = await pool.query<{ role: "admin" | "user" }>(
    `SELECT role FROM users WHERE id = $1 LIMIT 1`,
    [payload.userId],
  );
  if (!rows[0]) return null;
  return payload;
}

export const requireSession: MiddlewareHandler = async (c, next) => {
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  c.set("session", session);
  await next();
};

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthenticated" }, 401);
  if (session.role !== "admin") return c.json({ error: "forbidden" }, 403);
  c.set("session", session);
  await next();
};
