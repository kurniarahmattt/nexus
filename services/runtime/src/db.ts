import { Pool } from "pg";
import { env } from "./env.ts";

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export interface AgentMentionable {
  id: string;
  slug: string;
  rocketchat_username: string;
  kind: "shared" | "remote";
}

/** All bots we can route mentions to (used by hop detector). */
export async function allBots(): Promise<AgentMentionable[]> {
  const { rows } = await pool.query<AgentMentionable>(
    `SELECT id, slug, rocketchat_username, kind
       FROM agents WHERE enabled = true`,
  );
  return rows;
}

export async function roomIdFromRid(rocketchatRid: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM rooms WHERE rocketchat_rid = $1 LIMIT 1`,
    [rocketchatRid],
  );
  return rows[0]?.id ?? null;
}

export interface AgentCreds {
  id: string;
  slug: string;
  rocketchat_username: string;
  kind: "shared" | "remote";
  auth_token: string;
  auth_user_id: string;
}

export async function getAgentCreds(slug: string): Promise<AgentCreds | null> {
  const { rows } = await pool.query<{
    id: string;
    slug: string;
    rocketchat_username: string;
    kind: "shared" | "remote";
    config: { auth_token?: string; auth_user_id?: string };
  }>(
    `SELECT id, slug, rocketchat_username, kind, config
       FROM agents WHERE slug = $1 AND enabled = true LIMIT 1`,
    [slug],
  );
  const row = rows[0];
  if (!row) return null;
  const token = row.config.auth_token;
  const uid = row.config.auth_user_id;
  if (!token || !uid) return null;
  return {
    id: row.id,
    slug: row.slug,
    rocketchat_username: row.rocketchat_username,
    kind: row.kind,
    auth_token: token,
    auth_user_id: uid,
  };
}
