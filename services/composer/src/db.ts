import { Pool } from "pg";
import { env } from "./env.ts";

export const pool = new Pool({ connectionString: env.DATABASE_URL });

export interface AgentRow {
  id: string;
  slug: string;
  rocketchat_username: string;
  config: {
    system_prompt?: string;
    [k: string]: unknown;
  };
}

export async function getAgent(slug: string): Promise<AgentRow | null> {
  const { rows } = await pool.query<AgentRow>(
    `SELECT id, slug, rocketchat_username, config
       FROM agents WHERE slug = $1 AND enabled = true LIMIT 1`,
    [slug],
  );
  return rows[0] ?? null;
}

export interface TranscriptRow {
  mid: string;
  text: string;
  ts: Date;
  sender_username: string;   // resolved from users or agents
  sender_kind: "user" | "agent";
}

/**
 * Fetch last N messages in a room (excluding the one just ingested would be
 * nice, but DB-wise we just fetch N most recent and the composer can
 * deduplicate against triggerMessageId if needed).
 */
export async function lastMessages(params: {
  roomId: string;
  limit: number;
}): Promise<TranscriptRow[]> {
  const { rows } = await pool.query<{
    mid: string;
    text: string;
    ts: Date;
    user_username: string | null;
    agent_username: string | null;
  }>(
    `SELECT m.rocketchat_mid AS mid, m.text, m.ts,
            u.username AS user_username,
            a.rocketchat_username AS agent_username
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
       LEFT JOIN agents a ON a.id = m.sender_agent_id
      WHERE m.room_id = $1
      ORDER BY m.ts DESC
      LIMIT $2`,
    [params.roomId, params.limit],
  );
  // Reverse to chronological order.
  return rows.reverse().map((r) => {
    const isAgent = r.agent_username !== null;
    return {
      mid: r.mid,
      text: r.text,
      ts: r.ts,
      sender_username: isAgent ? r.agent_username! : (r.user_username ?? "unknown"),
      sender_kind: isAgent ? "agent" : "user",
    };
  });
}

export async function getRoomInfo(roomId: string): Promise<{
  name: string | null;
  kind: string;
  rocketchat_rid: string;
} | null> {
  const { rows } = await pool.query<{
    name: string | null;
    kind: string;
    rocketchat_rid: string;
  }>(
    `SELECT name, kind, rocketchat_rid FROM rooms WHERE id = $1`,
    [roomId],
  );
  return rows[0] ?? null;
}

export interface LandmarkRow {
  kind: string;
  reason: string | null;
  text: string;
  sender_username: string;
  ts: Date;
  pinned_at: Date;
}

/** Most recent N landmarks for a room, ordered by pinned_at DESC. */
export async function roomLandmarks(roomId: string, limit = 10): Promise<LandmarkRow[]> {
  const { rows } = await pool.query<{
    kind: string;
    reason: string | null;
    text: string;
    user_username: string | null;
    agent_username: string | null;
    ts: Date;
    pinned_at: Date;
  }>(
    `SELECT l.kind, l.reason, m.text, m.ts, l.pinned_at,
            u.username AS user_username, a.rocketchat_username AS agent_username
       FROM landmarks l
       JOIN messages m ON m.id = l.message_id
       LEFT JOIN users u ON u.id = m.sender_user_id
       LEFT JOIN agents a ON a.id = m.sender_agent_id
      WHERE l.room_id = $1
      ORDER BY l.pinned_at DESC
      LIMIT $2`,
    [roomId, limit],
  );
  return rows.map((r) => ({
    kind: r.kind,
    reason: r.reason,
    text: r.text,
    sender_username: r.agent_username ?? r.user_username ?? "unknown",
    ts: r.ts,
    pinned_at: r.pinned_at,
  }));
}

/**
 * Fetch the *oldest* window of messages that sit before the `recentLimit`
 * most recent. Returns [] if total <= recentLimit.
 */
export async function olderMessages(params: {
  roomId: string;
  recentLimit: number;
  olderLimit: number;
}): Promise<
  Array<{ mid: string; text: string; ts: Date; sender_username: string }>
> {
  const { rows } = await pool.query<{
    mid: string;
    text: string;
    ts: Date;
    user_username: string | null;
    agent_username: string | null;
  }>(
    `WITH recent AS (
       SELECT id FROM messages
        WHERE room_id = $1
        ORDER BY ts DESC LIMIT $2
     )
     SELECT m.rocketchat_mid AS mid, m.text, m.ts,
            u.username AS user_username,
            a.rocketchat_username AS agent_username
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_user_id
       LEFT JOIN agents a ON a.id = m.sender_agent_id
      WHERE m.room_id = $1
        AND m.id NOT IN (SELECT id FROM recent)
      ORDER BY m.ts DESC
      LIMIT $3`,
    [params.roomId, params.recentLimit, params.olderLimit],
  );
  return rows.reverse().map((r) => ({
    mid: r.mid,
    text: r.text,
    ts: r.ts,
    sender_username: r.agent_username ?? r.user_username ?? "unknown",
  }));
}
