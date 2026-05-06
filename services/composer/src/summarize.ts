/**
 * Phase 4 summarizer. Calls the OpenAI-compatible endpoint already used by
 * Mem0 (vLLM Gemma-4-31B for Mas). Caches in Postgres `summaries` table
 * keyed by room + (start_ts, end_ts) range.
 */

import { pool } from "./db.ts";
import { env } from "./env.ts";

export interface RawMsg {
  mid: string;
  sender_username: string;
  text: string;
  ts: Date;
}

export interface SummaryRow {
  id: number;
  summary: string;
  start_ts: Date;
  end_ts: Date;
  message_count: number;
}

/** Find a cached summary that covers `[startTs, endTs]` exactly (same bounds). */
export async function findSummary(
  roomId: string,
  startTs: Date,
  endTs: Date,
): Promise<SummaryRow | null> {
  const { rows } = await pool.query<SummaryRow>(
    `SELECT id, summary, start_ts, end_ts, message_count
       FROM summaries
      WHERE room_id = $1 AND tier = 'thread'
        AND start_ts = $2 AND end_ts = $3
      ORDER BY created_at DESC LIMIT 1`,
    [roomId, startTs, endTs],
  );
  return rows[0] ?? null;
}

function buildSummarizerPrompt(messages: RawMsg[]): string {
  const lines = messages
    .map(
      (m) =>
        `[${m.ts.toISOString().slice(11, 16)} | ${m.sender_username}] ${m.text.replace(/\s+/g, " ").slice(0, 300)}`,
    )
    .join("\n");
  return `You are summarizing a team chat room transcript. Output 5-10 concise bullet points in English covering:
- Facts established (who said what, constraints, preferences)
- Decisions made
- Action items / open questions
- Names, projects, numbers, paths mentioned

Preserve speaker attribution in each bullet. No preamble or conclusion.

Transcript (${messages.length} messages):
${lines}

Summary:`;
}

async function callLLM(prompt: string): Promise<string> {
  const resp = await fetch(`${env.MEM0_LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.MEM0_LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.MEM0_LLM_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 800,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`summarizer LLM ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/**
 * Ensure a summary exists for the given message window and return it.
 * Cached if already exists with same bounds. Blocking (composer awaits).
 */
export async function ensureSummary(
  roomId: string,
  messages: RawMsg[],
): Promise<SummaryRow | null> {
  if (messages.length < 3) return null;

  const startTs = messages[0]!.ts;
  const endTs = messages[messages.length - 1]!.ts;

  const cached = await findSummary(roomId, startTs, endTs);
  if (cached) return cached;

  const prompt = buildSummarizerPrompt(messages);
  const text = await callLLM(prompt);
  if (!text) return null;

  const { rows } = await pool.query<SummaryRow>(
    `INSERT INTO summaries (room_id, tier, start_ts, end_ts, summary, message_count)
     VALUES ($1, 'thread', $2, $3, $4, $5)
     RETURNING id, summary, start_ts, end_ts, message_count`,
    [roomId, startTs, endTs, text, messages.length],
  );
  return rows[0] ?? null;
}
