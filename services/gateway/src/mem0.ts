import { env } from "./env.ts";

export interface Mem0AddParams {
  userText: string;
  userName: string;           // namespaced id (username)
  rocketchatRid: string;
  roomKind: "channel" | "private" | "dm";
  targetAgentSlug?: string;   // only set if message mentions a bot
}

/** Fire-and-forget: do NOT await in hot path. */
export function fireMem0Add(p: Mem0AddParams, log: { error: (o: unknown, m: string) => void }): void {
  const runId =
    p.roomKind === "dm" && p.targetAgentSlug
      ? `dm:${p.userName}:${p.targetAgentSlug}`
      : `room:${p.rocketchatRid}`;

  const body = {
    messages: [{ role: "user", content: p.userText }],
    user_id: p.userName,
    agent_id: p.targetAgentSlug,
    run_id: runId,
    metadata: { rocketchat_rid: p.rocketchatRid, room_kind: p.roomKind },
  };

  void fetch(`${env.MEM0_API_URL}/memories`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(async (r) => {
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        log.error({ status: r.status, body: text.slice(0, 200) }, "mem0.add failed");
      }
    })
    .catch((err) => log.error({ err: String(err) }, "mem0.add network error"));
}
