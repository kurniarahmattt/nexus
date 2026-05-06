/**
 * Thin fetch wrapper with credentials. Dev: same-origin via Vite proxy;
 * prod: same-origin served by gateway.
 */

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(`/api${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...((init.headers ?? {}) as Record<string, string>),
    },
    ...init,
  });
  const text = await resp.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const body = data as { error?: string; detail?: string };
    throw new Error(body.error ?? `http_${resp.status}`);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => req<T>(path),
  post: <T>(path: string, body: unknown) =>
    req<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) =>
    req<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
};

export type Role = "admin" | "user";
export interface Me {
  id: string;
  username: string;
  display_name: string | null;
  role: Role;
  email: string | null;
}
export interface Bridge {
  slug: string;
  display_name: string;
  description: string | null;
  cli_kind: string;
  cwd: string;
  model: string | null;
  persona: string | null;
  last_connected_at: string | null;
  is_connected: boolean;
  enabled: boolean;
}
export interface Channel {
  id: string;
  rocketchat_rid: string;
  name: string | null;
  kind: string;
  created_at: string;
}
export interface AdminUser {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  role: Role;
  nexus_created: boolean;
  last_login_at: string | null;
  created_at: string;
}
export interface UserCreds {
  auth_token: string | null;
  rc_password: string | null;
  username: string;
  rocketchat_username: string | null;
}
