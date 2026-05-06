/**
 * Generic subprocess spawner for CLI adapters.
 * Wraps Bun.spawn with timeout + chunked stdout batching.
 */

import type { AdapterContext, AdapterResult } from "./types.ts";

export interface SpawnOpts {
  command: string;
  args: string[];
  /** Stream stdin content into the child (optional). */
  stdin?: string;
  /** Extra env vars. */
  env?: Record<string, string>;
  /** Batch onChunk every N ms or on newline boundary. */
  chunkFlushMs?: number;
}

export async function runProcess(
  opts: SpawnOpts,
  ctx: AdapterContext,
): Promise<AdapterResult> {
  const started = performance.now();
  const flushMs = opts.chunkFlushMs ?? 600;

  const proc = Bun.spawn({
    cmd: [opts.command, ...opts.args],
    cwd: ctx.workingDirectory,
    stdin: opts.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...(opts.env ?? {}),
    },
  });

  if (opts.stdin !== undefined && proc.stdin) {
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  }

  // Collect stdout + stderr, batch chunk notifications.
  let accumulated = "";
  let stderrBuf = "";
  let lastFlush = 0;
  let pendingFlush: ReturnType<typeof setTimeout> | null = null;

  const maybeFlush = (now: number) => {
    if (!ctx.onChunk) return;
    if (now - lastFlush < flushMs && pendingFlush) return;
    if (pendingFlush) {
      clearTimeout(pendingFlush);
      pendingFlush = null;
    }
    lastFlush = now;
    void ctx.onChunk(accumulated);
  };

  const scheduleFlush = () => {
    if (!ctx.onChunk) return;
    if (pendingFlush) return;
    pendingFlush = setTimeout(() => {
      pendingFlush = null;
      lastFlush = performance.now();
      void ctx.onChunk?.(accumulated);
    }, flushMs);
  };

  const readStdout = (async () => {
    if (!proc.stdout) return;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      accumulated += chunk;
      const now = performance.now();
      if (chunk.includes("\n")) maybeFlush(now);
      else scheduleFlush();
    }
  })();

  const readStderr = (async () => {
    if (!proc.stderr) return;
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrBuf += decoder.decode(value, { stream: true });
    }
  })();

  // Enforce timeout.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, ctx.timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timer);
  await Promise.all([readStdout, readStderr]);
  if (pendingFlush) {
    clearTimeout(pendingFlush);
    void ctx.onChunk?.(accumulated);
  }

  const durationMs = Math.round(performance.now() - started);
  if (timedOut) {
    return {
      ok: false,
      output: accumulated,
      exitCode: null,
      durationMs,
      errorText: `timeout after ${ctx.timeoutMs}ms`,
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      output: accumulated,
      exitCode,
      durationMs,
      errorText: stderrBuf.trim() || `exit ${exitCode}`,
    };
  }
  return { ok: true, output: accumulated, exitCode, durationMs };
}
