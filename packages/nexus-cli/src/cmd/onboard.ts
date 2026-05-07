import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { spawn } from "bun";

import { c, log } from "../lib/colors.ts";
import { ask, confirm } from "../lib/prompt.ts";

interface OnboardArgs {
  // Join URL form (preferred)
  joinUrl?: string;
  // Legacy 3-flag form (still works)
  server?: string;
  token?: string;
  config?: string;
  // Common
  persistent?: boolean;
  allowInsecure?: boolean;
}

function parseArgs(argv: string[]): OnboardArgs {
  const args: OnboardArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case "--server":          args.server = next; i++; break;
      case "--token":           args.token = next;  i++; break;
      case "--config":          args.config = next; i++; break;
      case "--join":            args.joinUrl = next; i++; break;
      case "--persistent":      args.persistent = true; break;
      case "--allow-insecure":  args.allowInsecure = true; break;
      case "-h": case "--help":
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith("-")) {
          log.err(`unknown arg: ${a}`);
          printHelp();
          process.exit(2);
        }
        // Positional: treat as join URL if it looks like one.
        if (/^https?:\/\//.test(a) && !args.joinUrl) {
          args.joinUrl = a;
        }
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`${c.bold("nexus onboard")} — join an existing Nexus instance as a bridge

${c.bold("Usage:")}
  nexus onboard <join-url>                    ${c.dim("# recommended")}
  nexus onboard                               ${c.dim("# interactive prompts")}
  nexus onboard --join <url>
  nexus onboard --server <ws-url> --token <t> --config <path>   ${c.dim("# legacy")}

${c.bold("Options:")}
  <join-url>          A nexus join URL like https://nexus.team.com/join/<code>
  --join <url>        Same as the positional join URL
  --server <url>      Gateway WebSocket URL (legacy)
  --token <token>     Bridge token (legacy)
  --config <path>     Path to a bridges/<slug>.json file (legacy)
  --persistent        Register a systemd user unit for auto-restart (Linux)
  --allow-insecure    Allow plaintext http:// join URLs (NOT recommended)
  -h, --help          Show this help

${c.bold("Examples:")}
  nexus onboard https://nexus.team.com/join/abc123def
  nexus onboard --join https://nexus.team.com/join/abc123def --persistent
`);
}

export async function onboard(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  console.log(`
${c.bold("Joining a Nexus host as a bridge.")}
`);

  // Bun must be present (we'll spawn it to run the bundle).
  if (!(await commandExists("bun"))) {
    log.err("Bun is required but not found. Install with: curl -fsSL https://bun.sh/install | bash");
    process.exit(1);
  }
  log.ok("Bun present");

  // ── Path 1: join URL ────────────────────────────────────────────────
  if (args.joinUrl) {
    await onboardViaJoinUrl(args.joinUrl, args);
    return;
  }

  // No flags / URL — interactive: ask whether the dev has a join URL.
  if (!args.server && !args.token && !args.config) {
    const hasUrl = await confirm("Do you have a join URL from your admin?", true);
    if (hasUrl) {
      const url = (await ask("Paste the join URL")).trim();
      if (url) {
        args.joinUrl = url;
        await onboardViaJoinUrl(url, args);
        return;
      }
    }
  }

  // ── Path 2: legacy 3-flag flow ──────────────────────────────────────
  await onboardViaLegacyFlags(args);
}

// ── Path 1 implementation ─────────────────────────────────────────────

async function onboardViaJoinUrl(url: string, args: OnboardArgs): Promise<void> {
  // Security gate: insist on https unless --allow-insecure.
  if (!url.startsWith("https://") && !args.allowInsecure) {
    if (url.startsWith("http://")) {
      log.err("plaintext http:// join URL refused (token would travel in clear text).");
      log.info(`Pass --allow-insecure if you accept the risk (LAN-only deploys, etc.).`);
      process.exit(1);
    }
    log.err(`unrecognised join URL: ${url}`);
    process.exit(2);
  }

  log.info(`exchanging join code at ${maskUrl(url)}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "User-Agent": "nexus-cli/0.1" },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string; consumed_at?: string; expires_at?: string };
      if (body.error) msg = body.error;
      if (body.consumed_at) msg += ` (consumed at ${body.consumed_at})`;
      if (body.expires_at) msg += ` (expired at ${body.expires_at})`;
    } catch { /* keep generic */ }
    log.err(`join failed: ${msg}`);
    if (res.status === 410) {
      log.info("ask your admin to issue a fresh link: make issue-join-link SLUG=<slug>");
    }
    process.exit(1);
  }

  const payload = await res.json() as {
    slug: string;
    server: string;
    bridge_token: string;
    config: Record<string, unknown>;
  };

  if (!payload.slug || !payload.server || !payload.bridge_token) {
    log.err("server response missing required fields");
    process.exit(1);
  }
  log.ok(`code accepted for ${c.bold(payload.slug)}`);

  await stageAndRun({
    slug: payload.slug,
    server: payload.server,
    token: payload.bridge_token,
    configContent: payload.config,
    persistent: args.persistent ?? false,
  });
}

function maskUrl(url: string): string {
  // Hide the actual code in console output; keep host visible.
  return url.replace(/\/join\/[^/?#]+/, "/join/<code-redacted>");
}

// ── Path 2 implementation (legacy) ────────────────────────────────────

async function onboardViaLegacyFlags(args: OnboardArgs): Promise<void> {
  const server = args.server ?? await ask("Gateway URL (e.g. wss://nexus.team.com/bridge)");
  if (!server || !/^wss?:\/\//.test(server)) {
    log.err("--server must be a ws:// or wss:// URL");
    process.exit(2);
  }
  if (server.startsWith("ws://") && !args.allowInsecure) {
    log.warn("plaintext ws:// — bridge token will travel in clear text on this network.");
  }

  const token = args.token ?? await ask("Bridge token");
  if (!token || token.length < 16) {
    log.err("token looks too short — paste the full hex string from your admin");
    process.exit(2);
  }

  const configPath = args.config ?? await ask("Path to bridge config JSON file");
  if (!configPath || !existsSync(configPath)) {
    log.err(`config file not found: ${configPath}`);
    process.exit(1);
  }

  let configContent: Record<string, unknown>;
  let slug: string;
  try {
    configContent = JSON.parse(readFileSync(configPath, "utf8"));
    slug = (configContent.slug as string | undefined) ?? basename(configPath, ".json");
  } catch (e) {
    log.err(`could not parse config JSON: ${(e as Error).message}`);
    process.exit(1);
  }

  await stageAndRun({
    slug,
    server,
    token,
    configContent,
    persistent: args.persistent ?? false,
  });
}

// ── Common: stage files and run/install ───────────────────────────────

async function stageAndRun(opts: {
  slug: string;
  server: string;
  token: string;
  configContent: Record<string, unknown>;
  persistent: boolean;
}): Promise<void> {
  const nexusHome = process.env.NEXUS_HOME ?? join(homedir(), ".nexus");
  mkdirSync(nexusHome, { recursive: true });

  const stagedConfig = join(nexusHome, `${opts.slug}.json`);
  writeFileSync(stagedConfig, JSON.stringify(opts.configContent, null, 2));
  log.ok(`config staged at ${stagedConfig}`);

  const bundleUrl = deriveBundleUrl(opts.server);
  const bundlePath = join(nexusHome, "nexus-bridge.js");

  log.info(`fetching bridge bundle from ${bundleUrl}`);
  const ok = await downloadFile(bundleUrl, bundlePath);
  if (!ok) {
    log.err(`could not fetch bundle from ${bundleUrl}`);
    log.info("possible causes:");
    console.log(
      "  • host gateway is offline / unreachable from this network\n" +
      "  • the gateway hasn't run `make build-bridge` yet\n" +
      "  • the URL has a typo (must end with /bridge)\n",
    );
    process.exit(1);
  }
  const sz = (await Bun.file(bundlePath).size).toLocaleString();
  log.ok(`bundle saved (${sz} bytes)`);

  if (opts.persistent) {
    if (process.platform !== "linux") {
      log.warn("--persistent currently supports Linux/systemd only. Running in foreground.");
    } else {
      writeSystemdUnit({
        slug: opts.slug,
        server: opts.server,
        token: opts.token,
        bundlePath,
        configPath: stagedConfig,
      });
      return;
    }
  }

  console.log(`
${c.green(c.bold("✓ Bridge ready."))}

  ${c.bold("Slug:")}    ${opts.slug}
  ${c.bold("Server:")}  ${opts.server}
  ${c.bold("Config:")}  ${stagedConfig}
  ${c.bold("Bundle:")}  ${bundlePath}

  ${c.dim("Press Ctrl-C to stop.")}
`);

  const proc = spawn(["bun", bundlePath, "--config", stagedConfig, "--server", opts.server], {
    env: { ...process.env, NEXUS_BRIDGE_TOKEN: opts.token },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  process.exit(proc.exitCode ?? 0);
}

function deriveBundleUrl(serverWsUrl: string): string {
  const baseHttp = serverWsUrl
    .replace(/^ws:\/\//, "http://")
    .replace(/^wss:\/\//, "https://")
    .replace(/\/bridge$/, "");
  return `${baseHttp}/admin/download/nexus-bridge.js`;
}

async function downloadFile(url: string, dest: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return false;
    const buf = new Uint8Array(await res.arrayBuffer());
    writeFileSync(dest, buf);
    return true;
  } catch {
    return false;
  }
}

function writeSystemdUnit(opts: {
  slug: string;
  server: string;
  token: string;
  bundlePath: string;
  configPath: string;
}): void {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(unitDir, { recursive: true });
  const unitFile = join(unitDir, `nexus-bridge@${opts.slug}.service`);
  const bunPath = process.env.BUN_INSTALL
    ? join(process.env.BUN_INSTALL, "bin", "bun")
    : "/usr/bin/env bun";

  const unit = `[Unit]
Description=Nexus bridge (${opts.slug})
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${bunPath} ${opts.bundlePath} --config ${opts.configPath} --server ${opts.server}
Environment=NEXUS_BRIDGE_TOKEN=${opts.token}
Restart=on-failure
RestartSec=5
PrivateTmp=true

[Install]
WantedBy=default.target
`;
  writeFileSync(unitFile, unit, { mode: 0o600 });
  log.ok(`systemd unit written to ${unitFile}`);
  log.info("to enable:");
  console.log(`    systemctl --user daemon-reload`);
  console.log(`    systemctl --user enable --now nexus-bridge@${opts.slug}`);
  log.info("to view logs:");
  console.log(`    journalctl --user -u nexus-bridge@${opts.slug} -f`);
}

async function commandExists(name: string): Promise<boolean> {
  try {
    const proc = spawn(["which", name], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
