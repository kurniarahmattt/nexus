/**
 * Admin-auth fallback poster. Login as admin on boot, refresh token hourly.
 * Used to surface errors (missing creds, unhandled throws, crashed CLI) that
 * happen before a bot placeholder can be posted.
 */

import pino from "pino";
import { env } from "./env.ts";

const log = pino({ level: env.LOG_LEVEL });

interface AdminCreds {
  token: string;
  userId: string;
  expiresAt: number;
}

let cached: AdminCreds | null = null;

async function loginAdmin(): Promise<AdminCreds | null> {
  const user = process.env.ROCKETCHAT_ADMIN_USERNAME ?? "admin";
  const pass = process.env.ROCKETCHAT_ADMIN_PASSWORD;
  if (!pass) {
    log.warn("ROCKETCHAT_ADMIN_PASSWORD unset — fallback poster disabled");
    return null;
  }
  const resp = await fetch(`${env.ROCKETCHAT_URL}/api/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user, password: pass }),
  });
  if (!resp.ok) {
    log.warn({ status: resp.status }, "admin login failed");
    return null;
  }
  const data = (await resp.json()) as {
    data?: { authToken: string; userId: string };
  };
  if (!data.data?.authToken) return null;
  return {
    token: data.data.authToken,
    userId: data.data.userId,
    expiresAt: Date.now() + 60 * 60 * 1000, // refresh hourly
  };
}

async function getAdmin(): Promise<AdminCreds | null> {
  if (cached && cached.expiresAt > Date.now()) return cached;
  cached = await loginAdmin();
  return cached;
}

/**
 * Post a system error message to a room. Returns message id or null on
 * failure. Uses admin creds so it still works even when bot creds are broken.
 */
export async function postFallback(rid: string, text: string): Promise<string | null> {
  const a = await getAdmin();
  if (!a) {
    log.error({ rid, text: text.slice(0, 100) }, "no admin creds, fallback skipped");
    return null;
  }
  const resp = await fetch(`${env.ROCKETCHAT_URL}/api/v1/chat.postMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Auth-Token": a.token,
      "X-User-Id": a.userId,
    },
    body: JSON.stringify({ channel: rid, text, alias: "nexus-system" }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    log.error(
      { status: resp.status, body: body.slice(0, 200) },
      "fallback post failed",
    );
    return null;
  }
  const data = (await resp.json()) as { message?: { _id?: string } };
  return data.message?._id ?? null;
}

/** Eager warm-up at runtime boot. */
export async function warmFallback(): Promise<boolean> {
  const a = await getAdmin();
  return a !== null;
}
