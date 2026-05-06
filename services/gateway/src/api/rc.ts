/**
 * Thin Rocket.Chat admin client. Keeps one cached login session to admin;
 * refresh hourly.
 */

import { env } from "../env.ts";

interface AdminCreds {
  token: string;
  userId: string;
  exp: number;
}

let cached: AdminCreds | null = null;

async function login(): Promise<AdminCreds> {
  const resp = await fetch(`${env.ROCKETCHAT_URL}/api/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user: env.ROCKETCHAT_ADMIN_USERNAME,
      password: env.ROCKETCHAT_ADMIN_PASSWORD,
    }),
  });
  if (!resp.ok) throw new Error(`rc login ${resp.status}`);
  const data = (await resp.json()) as { data?: { authToken: string; userId: string } };
  if (!data.data?.authToken) throw new Error("rc login: no authToken");
  return {
    token: data.data.authToken,
    userId: data.data.userId,
    exp: Date.now() + 60 * 60 * 1000,
  };
}

async function creds(): Promise<AdminCreds> {
  if (cached && cached.exp > Date.now()) return cached;
  cached = await login();
  return cached;
}

async function rcFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const c = await creds();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Auth-Token": c.token,
    "X-User-Id": c.userId,
    ...((init.headers ?? {}) as Record<string, string>),
  };
  return fetch(`${env.ROCKETCHAT_URL}${path}`, { ...init, headers });
}

// (no-op placeholder to keep exports stable)
// ── Users ──────────────────────────────────────────────────────────────
export async function createUser(p: {
  username: string;
  email: string;
  name: string;
  password: string;
  roles?: string[];
}): Promise<string> {
  const resp = await rcFetch("/api/v1/users.create", {
    method: "POST",
    body: JSON.stringify({
      username: p.username,
      email: p.email,
      name: p.name,
      password: p.password,
      verified: true,
      active: true,
      roles: p.roles ?? ["user"],
      joinDefaultChannels: false,
      requirePasswordChange: false,
      sendWelcomeEmail: false,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`users.create ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { user?: { _id: string } };
  if (!data.user?._id) throw new Error("users.create: no _id");
  return data.user._id;
}

export async function userInfo(username: string): Promise<{ _id: string; username: string } | null> {
  const resp = await rcFetch(
    `/api/v1/users.info?username=${encodeURIComponent(username)}`,
  );
  if (!resp.ok) return null;
  const data = (await resp.json()) as { user?: { _id: string; username: string } };
  return data.user ?? null;
}

export async function updateUser(p: {
  userId: string;
  name?: string;
  username?: string;
  password?: string;
  active?: boolean;
  verified?: boolean;
}): Promise<void> {
  const data: Record<string, unknown> = {};
  if (p.name) data.name = p.name;
  if (p.username) data.username = p.username;
  if (p.password) data.password = p.password;
  if (p.active !== undefined) data.active = p.active;
  if (p.verified !== undefined) data.verified = p.verified;
  const resp = await rcFetch("/api/v1/users.update", {
    method: "POST",
    body: JSON.stringify({ userId: p.userId, data }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`users.update ${resp.status}: ${text.slice(0, 200)}`);
  }
}

// ── Channels / Groups ──────────────────────────────────────────────────
export async function createRoom(p: {
  name: string;
  kind: "channel" | "private";
  members: string[];
}): Promise<{ _id: string; name: string }> {
  const endpoint = p.kind === "private" ? "/api/v1/groups.create" : "/api/v1/channels.create";
  const resp = await rcFetch(endpoint, {
    method: "POST",
    body: JSON.stringify({ name: p.name, members: p.members }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${endpoint} ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    channel?: { _id: string; name: string };
    group?: { _id: string; name: string };
  };
  const room = data.channel ?? data.group;
  if (!room) throw new Error("createRoom: no room id");
  return room;
}

export async function inviteToRoom(p: {
  roomName: string;
  username: string;
  kind: "channel" | "private";
}): Promise<boolean> {
  for (const endpoint of ["/api/v1/channels.invite", "/api/v1/groups.invite"]) {
    if (p.kind === "channel" && endpoint.includes("groups")) continue;
    if (p.kind === "private" && endpoint.includes("channels")) continue;
    const resp = await rcFetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ roomName: p.roomName, username: p.username }),
    });
    if (resp.ok) return true;
  }
  // Fallback: try both endpoints if we don't know the kind.
  for (const endpoint of ["/api/v1/channels.invite", "/api/v1/groups.invite"]) {
    const resp = await rcFetch(endpoint, {
      method: "POST",
      body: JSON.stringify({ roomName: p.roomName, username: p.username }),
    });
    if (resp.ok) return true;
  }
  return false;
}

export async function addTriggerWord(slug: string): Promise<void> {
  // Use mongo container — REST integrations update requires strict schema.
  // Exec via child_process; best-effort.
  const { spawnSync } = await import("node:child_process");
  spawnSync("docker", [
    "exec",
    "nexus-mongo",
    "mongosh",
    "rocketchat",
    "--quiet",
    "--eval",
    `const i=db.rocketchat_integrations.findOne({name:'nexus-outgoing'});
     if(i){const set=new Set(i.triggerWords||[]); set.add('@${slug}');
       db.rocketchat_integrations.updateOne({_id:i._id},
         {$set:{triggerWords:[...set], _updatedAt:new Date()}});}`,
  ]);
}

export async function clear2FA(username: string): Promise<void> {
  const { spawnSync } = await import("node:child_process");
  spawnSync("docker", [
    "exec",
    "nexus-mongo",
    "mongosh",
    "rocketchat",
    "--quiet",
    "--eval",
    `db.users.updateOne({username:'${username}'},{$unset:{'services.email2fa':'','services.totp':'','services.emailCode':''}});`,
  ]);
}

/**
 * Query Mongo directly for rocketchat_rid values the given RC user is
 * subscribed to. Used by channel ACL (user sees only joined channels).
 */
export async function rocketchatRidsForUser(rocketchatId: string): Promise<string[]> {
  const { spawnSync } = await import("node:child_process");
  const res = spawnSync("docker", [
    "exec",
    "nexus-mongo",
    "mongosh",
    "rocketchat",
    "--quiet",
    "--eval",
    `print(JSON.stringify(db.rocketchat_subscription.find({'u._id':'${rocketchatId.replace(/'/g, "")}'}, {rid:1,_id:0}).toArray().map(s => s.rid)))`,
  ]);
  const out = res.stdout?.toString().trim() ?? "";
  try {
    const arr = JSON.parse(out);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export async function botLogin(username: string, password: string): Promise<{ token: string; userId: string }> {
  const resp = await fetch(`${env.ROCKETCHAT_URL}/api/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: username, password }),
  });
  if (!resp.ok) throw new Error(`bot login ${resp.status}`);
  const data = (await resp.json()) as { data?: { authToken: string; userId: string } };
  if (!data.data?.authToken) throw new Error("bot login: no authToken");
  return { token: data.data.authToken, userId: data.data.userId };
}
