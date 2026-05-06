/**
 * Debounce buffer per (room_id + user_id). When a user mentions a bot,
 * open a window; any subsequent message from the same user in the same
 * room — with or without mention — appends text and resets the timer.
 * On quiet timeout, flush the combined buffer to the invoke pipeline.
 *
 * This lets users keep typing across multiple enter-presses without the
 * bot prematurely answering an incomplete prompt.
 */

import { randomUUID } from "node:crypto";
import type { AgentRow } from "./db.ts";

export interface PendingFlush {
  rocketchatRid: string;
  roomId: string;
  triggerMessageId: string;
  userId: string;
  username: string;
  combinedText: string;       // full concatenation of user messages in window
  agents: AgentRow[];         // bots mentioned anywhere in combinedText
  firstTs: string;            // ISO of first message in window
}

export type FlushFn = (data: PendingFlush) => Promise<void> | void;

interface PendingEntry extends PendingFlush {
  timer: ReturnType<typeof setTimeout>;
}

export class Debouncer {
  private map = new Map<string, PendingEntry>();
  constructor(
    private flushMs: number,
    private onFlush: FlushFn,
  ) {}

  private key(rid: string, userId: string): string {
    return `${rid}:${userId}`;
  }

  /**
   * Ingest a message. Returns how it was handled: 'started' opens a new
   * window, 'appended' extended an existing window, 'ignored' means no
   * mention and no existing window.
   */
  ingest(args: {
    rocketchatRid: string;
    roomId: string;
    triggerMessageId: string;
    userId: string;
    username: string;
    text: string;
    ts: string;
    detectedAgents: AgentRow[];
  }): "started" | "appended" | "ignored" {
    const k = this.key(args.rocketchatRid, args.userId);
    const existing = this.map.get(k);

    if (existing) {
      clearTimeout(existing.timer);
      existing.combinedText = `${existing.combinedText}\n${args.text}`;
      // New mentions in the latest chunk also count.
      const merged = new Map<string, AgentRow>();
      for (const a of existing.agents) merged.set(a.id, a);
      for (const a of args.detectedAgents) merged.set(a.id, a);
      existing.agents = [...merged.values()];
      existing.triggerMessageId = args.triggerMessageId; // use latest mid as anchor
      existing.timer = setTimeout(() => this.flush(k), this.flushMs);
      return "appended";
    }

    if (args.detectedAgents.length === 0) return "ignored";

    const entry: PendingEntry = {
      rocketchatRid: args.rocketchatRid,
      roomId: args.roomId,
      triggerMessageId: args.triggerMessageId,
      userId: args.userId,
      username: args.username,
      combinedText: args.text,
      agents: args.detectedAgents,
      firstTs: args.ts,
      timer: setTimeout(() => this.flush(k), this.flushMs),
    };
    this.map.set(k, entry);
    return "started";
  }

  private async flush(k: string): Promise<void> {
    const entry = this.map.get(k);
    if (!entry) return;
    this.map.delete(k);
    const { timer: _t, ...data } = entry;
    try {
      await this.onFlush(data);
    } catch (err) {
      // Swallow — caller log via their own wrapper.
      console.error("debouncer flush error", err);
    }
  }

  size(): number {
    return this.map.size;
  }
}

// Re-exported for tests / consumers needing a fresh uuid (kept here for
// colocation with flush payloads).
export const newJobId = randomUUID;
