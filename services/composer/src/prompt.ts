/**
 * Attribution prompt builder — Phase 3a.
 * Ref: PLANNING.md §5.3.
 */

import type { TranscriptRow, LandmarkRow } from "./db.ts";
import type { RecallItem } from "./mem0.ts";

export interface ComposeArgs {
  agentUsername: string;          // e.g. "claude"
  roomName: string | null;        // e.g. "nexus-test" or null for DM
  roomKind: string;               // "channel" | "private" | "dm"
  triggerUsername: string;        // speaker of the current request
  triggerKind?: "user" | "agent"; // is the speaker another bot? (bot-to-bot)
  triggerText: string;            // cleaned text (mentions stripped)
  transcript: TranscriptRow[];    // chronological, oldest first
  recall?: RecallItem[];          // Mem0 semantic recall (optional)
  landmarks?: LandmarkRow[];      // pinned decisions/specs/actions
  priorSummary?: string | null;   // compressed summary of older messages
  priorSummaryRange?: { start: Date; end: Date; count: number } | null;
  hop?: number;                   // bot-to-bot hop depth
}

function fmtTime(ts: Date): string {
  const hh = String(ts.getHours()).padStart(2, "0");
  const mm = String(ts.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function composeUserPrompt(a: ComposeArgs): string {
  const participants = new Set<string>();
  for (const t of a.transcript) participants.add(t.sender_username);
  participants.add(a.triggerUsername);
  // Remove self-mention of the bot from "other participants" list.
  participants.delete(a.agentUsername);

  const header: string[] = [
    "[TEAM CONTEXT]",
    a.roomKind === "dm"
      ? `You are in a direct message with @${a.triggerUsername}.`
      : `Channel: #${a.roomName ?? "?"} (${a.roomKind})`,
    `You are: @${a.agentUsername}`,
    participants.size
      ? `Other participants in recent history: ${[...participants].map((u) => "@" + u).join(", ")}`
      : "No other participants yet.",
  ];

  const recallLines: string[] = [];
  const recall = (a.recall ?? []).filter((r) => r.score >= 0.3);
  if (recall.length) {
    recallLines.push("", "[RECALL — long-term memory]");
    for (const r of recall) {
      recallLines.push(`- ${r.memory}`);
    }
  }

  const summaryLines: string[] = [];
  if (a.priorSummary && a.priorSummaryRange) {
    const r = a.priorSummaryRange;
    summaryLines.push(
      "",
      `[EARLIER SESSION SUMMARY — ${r.count} messages, ${r.start.toISOString().slice(0, 16)} → ${r.end.toISOString().slice(0, 16)}]`,
      a.priorSummary,
    );
  }

  const landmarkLines: string[] = [];
  const landmarks = a.landmarks ?? [];
  if (landmarks.length) {
    landmarkLines.push("", "[LANDMARKS — pinned messages]");
    for (const l of landmarks) {
      const date = l.ts.toISOString().slice(0, 10);
      const preview = l.text.replace(/\s+/g, " ").slice(0, 200);
      landmarkLines.push(`- [${date} | ${l.sender_username} | ${l.kind}] ${preview}`);
    }
  }

  const transcriptLines: string[] = ["", "[RECENT MESSAGES]"];
  if (a.transcript.length === 0) {
    transcriptLines.push("(none yet)");
  } else {
    for (const m of a.transcript) {
      const tag = m.sender_username === a.agentUsername ? "(you)" : "";
      const line = `[${fmtTime(m.ts)} | ${m.sender_username}] ${tag} ${m.text}`.replace(/\s+/g, " ").trim();
      transcriptLines.push(line);
    }
  }

  const speakerLabel =
    a.triggerKind === "agent"
      ? `another bot (@${a.triggerUsername}) addressed you`
      : `@${a.triggerUsername} just asked`;
  const hopNote =
    a.triggerKind === "agent" && (a.hop ?? 0) > 0
      ? ` [bot-to-bot hop ${a.hop}/2 — keep your reply short, terminate the chain quickly]`
      : "";

  const task: string[] = [
    "",
    "[BOT COMMUNICATION]",
    "To reach another bot in this chat, include their @slug anywhere in your",
    "reply text (e.g. `@claude`, `@hermes-admin-hermes`). Nexus will route the",
    "mention automatically; bot-to-bot chains terminate after 2 hops. Do NOT",
    "use any internal Task/SendMessage/subagent tool — those are local to your",
    "CLI and cannot reach other Nexus bots.",
    "",
    "[CURRENT INVOCATION]",
    `${speakerLabel}:${hopNote}`,
    a.triggerText || "(empty)",
    "",
    "Respond concisely. Do not restate the history. Address the speaker.",
  ];

  return [
    ...header,
    ...recallLines,
    ...summaryLines,
    ...landmarkLines,
    ...transcriptLines,
    ...task,
  ].join("\n");
}
