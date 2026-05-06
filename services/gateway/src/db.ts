import { Pool } from "pg";
import { env } from "./env.ts";

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export interface AgentRow {
  id: string;
  slug: string;
  rocketchat_username: string;
  rocketchat_bot_id: string | null;
  config: Record<string, unknown>;
}

export async function loadAgents(): Promise<AgentRow[]> {
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, slug, rocketchat_username, rocketchat_bot_id, config
       FROM agents WHERE enabled = true`,
  );
  return rows;
}

export async function upsertUser(params: {
  rocketchatId: string;
  username: string;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (rocketchat_id, username)
     VALUES ($1, $2)
     ON CONFLICT (rocketchat_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING id`,
    [params.rocketchatId, params.username],
  );
  return rows[0]!.id;
}

export async function upsertRoom(params: {
  rocketchatRid: string;
  kind: "channel" | "private" | "dm";
  name: string | null;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO rooms (rocketchat_rid, kind, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (rocketchat_rid) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [params.rocketchatRid, params.kind, params.name],
  );
  return rows[0]!.id;
}

export async function insertMessage(params: {
  rocketchatMid: string;
  roomId: string;
  senderUserId: string | null;
  senderAgentId: string | null;
  text: string;
  ts: Date;
  metadata?: Record<string, unknown>;
}): Promise<number | null> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO messages
      (rocketchat_mid, room_id, sender_user_id, sender_agent_id, text, ts, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (rocketchat_mid) DO NOTHING
     RETURNING id`,
    [
      params.rocketchatMid,
      params.roomId,
      params.senderUserId,
      params.senderAgentId,
      params.text,
      params.ts,
      params.metadata ?? {},
    ],
  );
  return rows[0]?.id ?? null;
}
