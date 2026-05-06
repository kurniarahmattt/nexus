import { env } from "./env.ts";

export interface RecallItem {
  memory: string;
  score: number;
  user_id?: string;
  created_at?: string;
}

export interface Mem0SearchParams {
  query: string;
  userName: string;
  roomKind: "channel" | "private" | "dm";
  rocketchatRid: string;
  targetAgentSlug: string;
  limit?: number;
}

export async function mem0Recall(p: Mem0SearchParams): Promise<RecallItem[]> {
  const runId =
    p.roomKind === "dm"
      ? `dm:${p.userName}:${p.targetAgentSlug}`
      : `room:${p.rocketchatRid}`;

  const body = {
    query: p.query,
    user_id: p.userName,
    run_id: runId,
    limit: p.limit ?? 5,
  };

  const resp = await fetch(`${env.MEM0_API_URL}/memories/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`mem0 search ${resp.status}`);
  }
  const data = (await resp.json()) as {
    ok?: boolean;
    results?: { results?: RecallItem[] };
  };
  return data.results?.results ?? [];
}
