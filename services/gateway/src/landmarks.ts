/**
 * Phase 4 landmark heuristics.
 *
 * Fires on every ingested user message. Matches cheap regex / structural
 * patterns; never calls LLM. Inserts rows into `landmarks` table when any
 * pattern hits. The `kind` enum matches the CHECK constraint in migration
 * 0001 (decision | spec | code | link | question | action_item).
 */

import { pool } from "./db.ts";

export type LandmarkKind =
  | "decision"
  | "spec"
  | "code"
  | "link"
  | "question"
  | "action_item";

interface Hit {
  kind: LandmarkKind;
  reason: string;
}

const DECISION_RE =
  /\b(decision|agreed|sepakat|keputusan|kita pakai|let's use|we'll use)\s*:?\s/i;
const SPEC_RE = /\b(spec|specification|spesifikasi|design|desain)\s*:\s/i;
const ACTION_RE = /\b(todo|action item|tugas|harap|mohon|tolong|please)\s+\S/i;
const QUESTION_RE =
  /\?(\s|$).*\?(\s|$)|(kenapa|mengapa|bagaimana|apakah|why|how|what|when|where)\b.{20,}/i;
const URL_RE = /https?:\/\/\S{5,}/;
const EXPLICIT_RE = /^\s*!(landmark|pin|decision|spec|action)\b/i;

function countCodeFenceLines(text: string): number {
  const m = text.match(/```[\s\S]*?```/g);
  if (!m) return 0;
  let max = 0;
  for (const block of m) {
    const lines = block.split("\n").length - 2; // exclude fences
    if (lines > max) max = lines;
  }
  return max;
}

export function detectLandmarks(text: string): Hit[] {
  const hits: Hit[] = [];

  if (EXPLICIT_RE.test(text)) {
    const kind = (text.match(EXPLICIT_RE)?.[1]?.toLowerCase() ?? "decision") as LandmarkKind;
    hits.push({
      kind: ["pin", "landmark"].includes(kind) ? "decision" : (kind as LandmarkKind),
      reason: "user !marker",
    });
  }

  if (DECISION_RE.test(text)) hits.push({ kind: "decision", reason: "decision keyword" });
  if (SPEC_RE.test(text)) hits.push({ kind: "spec", reason: "spec keyword" });
  if (ACTION_RE.test(text)) hits.push({ kind: "action_item", reason: "action keyword" });

  const codeLines = countCodeFenceLines(text);
  if (codeLines >= 20) {
    hits.push({ kind: "code", reason: `code block ${codeLines} lines` });
  }

  if (URL_RE.test(text)) hits.push({ kind: "link", reason: "contains url" });

  // Question heuristic last — only fires if message is multi-sentence with
  // interrogative keywords, not a one-liner clarification.
  if (text.length > 80 && QUESTION_RE.test(text)) {
    hits.push({ kind: "question", reason: "long interrogative" });
  }

  // Dedupe by kind (first reason wins).
  const seen = new Set<string>();
  return hits.filter((h) => {
    if (seen.has(h.kind)) return false;
    seen.add(h.kind);
    return true;
  });
}

export async function persistLandmarks(
  messageId: number,
  roomId: string,
  hits: Hit[],
): Promise<void> {
  if (hits.length === 0) return;
  // Bulk insert; ON CONFLICT handles (message_id, kind) unique.
  const values: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const h of hits) {
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, 'heuristic')`);
    params.push(messageId, roomId, h.kind, h.reason);
  }
  await pool.query(
    `INSERT INTO landmarks (message_id, room_id, kind, reason, extracted_by)
     VALUES ${values.join(",")}
     ON CONFLICT (message_id, kind) DO NOTHING`,
    params,
  );
}
