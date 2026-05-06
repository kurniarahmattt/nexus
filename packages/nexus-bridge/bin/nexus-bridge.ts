#!/usr/bin/env bun
/**
 * nexus-bridge — user-installable WebSocket client.
 *
 * Connects to a Nexus server, receives invoke jobs, and runs the user's
 * local CLI (claude / hermes / cursor / gemini) in the user's workspace.
 *
 * Identity & persona are controlled by the USER via either:
 *   (a) a config file (JSON):   --config /path/to/bridge.json
 *   (b) inline flags:            --persona-file X.md  --display-name "..."  ...
 *
 * The bridge ships the identity inside its HELLO frame; the server updates
 * agents.config (system_prompt, display_name, description, model) so the
 * composer sees the persona on the next invocation.
 *
 * Env:
 *   NEXUS_BRIDGE_TOKEN   bridge token (required)
 *   NEXUS_BRIDGE_SERVER  ws URL (default ws://localhost:4000/bridge)
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { values: args } = parseArgs({
  options: {
    token: { type: "string" },
    server: { type: "string" },
    cwd: { type: "string" },
    cli: { type: "string" },
    config: { type: "string" },
    "persona-file": { type: "string" },
    persona: { type: "string" },
    "display-name": { type: "string" },
    description: { type: "string" },
    model: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (args.help) {
  console.log(`nexus-bridge — connect local AI CLI to a Nexus channel.

Env:
  NEXUS_BRIDGE_TOKEN   bridge token (required)
  NEXUS_BRIDGE_SERVER  ws URL (default ws://localhost:4000/bridge)

Flags:
  --token <t>            bridge token (overrides env)
  --server <url>         ws URL (overrides env)
  --cwd <path>           override server-stored CWD for this session
  --cli <name>           override CLI kind (claude|hermes|cursor|gemini)

Identity (pushed in hello frame):
  --config <file>        JSON config with { display_name, persona,
                         persona_file, description, model, cwd }
  --display-name <str>
  --persona <str>        inline persona (system prompt) text
  --persona-file <path>  read persona from a file (markdown/plain)
  --description <str>    one-liner for admin UI
  --model <str>          e.g. sonnet-4-6
`);
  process.exit(0);
}

interface BridgeConfig {
  display_name?: string;
  persona?: string;
  persona_file?: string;
  description?: string;
  model?: string;
  cwd?: string;
  cli?: string;
}

function loadConfig(path: string): BridgeConfig {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: cannot parse ${path} as JSON: ${(err as Error).message}`);
    process.exit(2);
  }
}

function readPersonaFile(path: string): string {
  if (!existsSync(path)) {
    console.error(`ERROR: persona-file not found: ${path}`);
    process.exit(2);
  }
  return readFileSync(path, "utf8").trim();
}

// Resolve identity from config file + flags (flags win).
const configFile: BridgeConfig = args.config ? loadConfig(args.config) : {};

const identity: {
  display_name?: string;
  persona?: string;
  description?: string;
  model?: string;
  cwd_override?: string;
} = {};

if (args["display-name"] ?? configFile.display_name) {
  identity.display_name = args["display-name"] ?? configFile.display_name;
}
if (args.persona) {
  identity.persona = args.persona;
} else if (args["persona-file"]) {
  identity.persona = readPersonaFile(args["persona-file"]);
} else if (configFile.persona) {
  identity.persona = configFile.persona;
} else if (configFile.persona_file) {
  identity.persona = readPersonaFile(configFile.persona_file);
}
if (args.description ?? configFile.description) {
  identity.description = args.description ?? configFile.description;
}
if (args.model ?? configFile.model) {
  identity.model = args.model ?? configFile.model;
}
if (args.cwd ?? configFile.cwd) {
  identity.cwd_override = args.cwd ?? configFile.cwd;
}

const hasIdentity = Object.keys(identity).length > 0;

const TOKEN = args.token ?? process.env.NEXUS_BRIDGE_TOKEN;
const SERVER =
  args.server ?? process.env.NEXUS_BRIDGE_SERVER ?? "ws://localhost:4000/bridge";
const CLI_OVERRIDE =
  args.cli ?? configFile.cli ?? process.env.NEXUS_BRIDGE_CLI ?? null;
const CWD_OVERRIDE = identity.cwd_override ?? null;

if (!TOKEN) {
  console.error("ERROR: --token or NEXUS_BRIDGE_TOKEN required");
  process.exit(2);
}

const RECONNECT_DELAY_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}
interface McpConfigShape {
  mcpServers: Record<string, McpServerEntry>;
}

interface InvokeFrame {
  type: "invoke";
  jobId: string;
  systemPrompt: string;
  userPrompt: string;
  workingDirectory: string;
  timeoutMs: number;
  mcpConfig?: McpConfigShape;
}

function writeMcpTemp(cfg: McpConfigShape): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nexus-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2), "utf8");
  return {
    path,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

interface WelcomeFrame {
  type: "welcome";
  slug: string;
  cli_kind: string;
  cwd: string;
}

interface AuthFailFrame {
  type: "auth_fail";
  reason: string;
}

interface PingFrame {
  type: "ping";
  ts: number;
}

type ServerFrame = InvokeFrame | WelcomeFrame | AuthFailFrame | PingFrame;

function log(level: "info" | "warn" | "error", msg: string, extra?: unknown) {
  const time = new Date().toISOString().slice(11, 19);
  const line = extra
    ? `[${time}] [${level.toUpperCase()}] ${msg} ${JSON.stringify(extra)}`
    : `[${time}] [${level.toUpperCase()}] ${msg}`;
  console.error(line);
}

function buildArgs(
  cli: string,
  systemPrompt: string,
  userPrompt: string,
  mcpConfigPath: string | null,
): string[] {
  const combined = systemPrompt
    ? `[SYSTEM]\n${systemPrompt}\n[/SYSTEM]\n\n${userPrompt}`
    : userPrompt;
  switch (cli) {
    case "claude": {
      const base = systemPrompt
        ? ["-p", userPrompt, "--system-prompt", systemPrompt, "--dangerously-skip-permissions"]
        : ["-p", userPrompt, "--dangerously-skip-permissions"];
      if (mcpConfigPath) base.push("--mcp-config", mcpConfigPath);
      return base;
    }
    case "cursor": {
      const base = ["-p", combined, "--yolo"];
      if (mcpConfigPath) base.push("--mcp-config", mcpConfigPath);
      return base;
    }
    case "hermes":
      return ["chat", "-q", combined, "-Q", "--yolo"];
    case "gemini":
      return ["-p", combined, "-y"];
    default:
      throw new Error(`unknown cli: ${cli}`);
  }
}

async function runLocal(
  cli: string,
  systemPrompt: string,
  userPrompt: string,
  cwd: string,
  timeoutMs: number,
  mcpConfig: McpConfigShape | undefined,
): Promise<{ ok: boolean; output: string; exitCode: number | null; errorText?: string; durationMs: number }> {
  const started = performance.now();
  const mcp = mcpConfig ? writeMcpTemp(mcpConfig) : null;
  const argv = buildArgs(cli, systemPrompt, userPrompt, mcp?.path ?? null);
  log("info", `spawn ${cli}`, { argv: argv.slice(0, 3), cwd, mcp: mcp?.path ?? "none" });

  const proc = Bun.spawn({
    cmd: [cli, ...argv],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
  });

  let stdout = "";
  let stderr = "";
  const readStdout = (async () => {
    if (!proc.stdout) return;
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }
  })();
  const readStderr = (async () => {
    if (!proc.stderr) return;
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
    }
  })();

  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(t);
  await Promise.all([readStdout, readStderr]);

  const durationMs = Math.round(performance.now() - started);
  mcp?.cleanup();
  if (timedOut) {
    return {
      ok: false,
      output: stdout,
      exitCode: null,
      errorText: `timeout after ${timeoutMs}ms`,
      durationMs,
    };
  }
  if (exitCode !== 0) {
    return {
      ok: false,
      output: stdout,
      exitCode,
      errorText: stderr.trim() || `exit ${exitCode}`,
      durationMs,
    };
  }
  return { ok: true, output: stdout.trim(), exitCode, durationMs };
}

function extractFinalText(rawOutput: string, cli: string): string {
  if (cli === "claude" || cli === "cursor") {
    const lines = rawOutput.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as { type?: string; result?: string };
        if (ev.type === "result" && typeof ev.result === "string") {
          return ev.result.trim();
        }
      } catch {
        /* not JSON */
      }
    }
    return rawOutput.trim();
  }
  const NOISE = /^(Warning:|Loading extension:|session_id:|╭|╰|│)/;
  return rawOutput
    .split(/\r?\n/)
    .filter((l) => !NOISE.test(l))
    .join("\n")
    .trim();
}

let ws: WebSocket | null = null;
let session: { slug: string; cli_kind: string; cwd: string } | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function connect() {
  log("info", `connecting to ${SERVER}`);
  ws = new WebSocket(SERVER);

  ws.addEventListener("open", () => {
    log("info", `ws opened, sending hello ${hasIdentity ? "with identity" : "(no identity override)"}`);
    const hello: Record<string, unknown> = {
      type: "hello",
      token: TOKEN,
      version: "0.1",
      capabilities: { streaming: false },
    };
    if (hasIdentity) hello.identity = identity;
    ws!.send(JSON.stringify(hello));
  });

  ws.addEventListener("message", async (ev) => {
    const data = typeof ev.data === "string" ? ev.data : String(ev.data);
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }

    if (frame.type === "welcome") {
      session = {
        slug: frame.slug,
        cli_kind: frame.cli_kind,
        cwd: frame.cwd,
      };
      log("info", "bridge authenticated", session);

      heartbeatTimer = setInterval(() => {
        try {
          ws?.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        } catch {
          /* ignore */
        }
      }, HEARTBEAT_INTERVAL_MS);
      return;
    }

    if (frame.type === "auth_fail") {
      log("error", `auth_fail: ${frame.reason}`);
      ws?.close();
      process.exit(3);
    }

    if (frame.type === "ping") {
      ws?.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      return;
    }

    if (frame.type === "invoke") {
      if (!session) {
        log("warn", "invoke before welcome, ignoring");
        return;
      }
      const cli = CLI_OVERRIDE ?? session.cli_kind;
      const cwd = CWD_OVERRIDE ?? frame.workingDirectory ?? session.cwd;
      log("info", `job ${frame.jobId.slice(0, 8)} (cli=${cli})`);
      try {
        const res = await runLocal(
          cli,
          frame.systemPrompt,
          frame.userPrompt,
          cwd,
          frame.timeoutMs,
          frame.mcpConfig,
        );
        const finalText = res.ok ? extractFinalText(res.output, cli) : res.output;
        ws?.send(
          JSON.stringify({
            type: "result",
            jobId: frame.jobId,
            ok: res.ok,
            output: finalText,
            durationMs: res.durationMs,
            exitCode: res.exitCode,
            errorText: res.errorText,
          }),
        );
        log("info", `job ${frame.jobId.slice(0, 8)} done ${res.ok ? "OK" : "FAIL"} (${res.durationMs}ms)`);
      } catch (err) {
        ws?.send(
          JSON.stringify({
            type: "result",
            jobId: frame.jobId,
            ok: false,
            output: "",
            errorText: `bridge: ${(err as Error).message}`,
          }),
        );
      }
    }
  });

  ws.addEventListener("close", (ev) => {
    session = null;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    log("warn", `ws closed code=${ev.code} reason=${ev.reason || "—"}`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.addEventListener("error", (ev) => {
    log("error", `ws error: ${(ev as any).message || ev}`);
  });
}

connect();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("info", `received ${sig}, closing`);
    try {
      ws?.close(1000, "shutdown");
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
}
