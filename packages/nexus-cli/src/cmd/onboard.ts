import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, basename, resolve } from "node:path";
import { spawn } from "bun";

import { c, log } from "../lib/colors.ts";
import { ask } from "../lib/prompt.ts";

interface OnboardArgs {
  server?: string;
  token?: string;
  config?: string;
  persistent?: boolean;
}

function parseArgs(argv: string[]): OnboardArgs {
  const args: OnboardArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case "--server":     args.server = next; i++; break;
      case "--token":      args.token = next;  i++; break;
      case "--config":     args.config = next; i++; break;
      case "--persistent": args.persistent = true; break;
      case "-h": case "--help":
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith("-")) {
          log.err(`unknown arg: ${a}`);
          printHelp();
          process.exit(2);
        }
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`${c.bold("nexus onboard")} — join an existing Nexus instance as a bridge

${c.bold("Usage:")}
  nexus onboard [options]
  nexus onboard                                       # interactive prompts
  nexus onboard --server <ws-url> --token <t> --config <path>

${c.bold("Options:")}
  --server <url>     Gateway WebSocket URL (ws://... or wss://...)
  --token <token>    Bridge token issued by your host admin
  --config <path>    Path to the bridges/<slug>.json file admin sent you
  --persistent       Register a systemd user unit for auto-restart (Linux)
  -h, --help         Show this help

${c.bold("Examples:")}
  nexus onboard
  nexus onboard --server wss://nexus.team.com/bridge \\
                --token abcd1234... \\
                --config ./claude-alice-backend.json
`);
}

export async function onboard(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  console.log(`
${c.bold("Joining a Nexus host as a bridge.")}

This connects your local AI CLI (Claude Code, Cursor, Gemini, or Hermes)
to a Nexus host run by your team. Your AI runs on this laptop with this
laptop's workspace; the bot identity is what others see in chat.
`);

  // 1. Verify Bun is callable as a child process (i.e. installed).
  const bunReady = await commandExists("bun");
  if (!bunReady) {
    log.err("Bun is required but not found. Install with: curl -fsSL https://bun.sh/install | bash");
    process.exit(1);
  }
  log.ok("Bun present");

  // 2. Collect inputs (interactive prompts fill what flags didn't).
  const server = args.server ?? await ask(
    "Gateway URL (e.g. wss://nexus.team.com/bridge)",
  );
  if (!server || !/^wss?:\/\//.test(server)) {
    log.err("--server must be a ws:// or wss:// URL");
    process.exit(2);
  }

  const token = args.token ?? await ask("Bridge token");
  if (!token || token.length < 16) {
    log.err("token looks too short — paste the full hex string from your admin");
    process.exit(2);
  }

  let configPath = args.config;
  if (!configPath) {
    configPath = await ask("Path to bridge config JSON file");
  }
  if (!configPath || !existsSync(configPath)) {
    log.err(`config file not found: ${configPath}`);
    process.exit(1);
  }

  // 3. Read slug from config.
  let slug: string;
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    slug = cfg.slug ?? basename(configPath, ".json");
  } catch (e) {
    log.err(`could not parse config JSON: ${(e as Error).message}`);
    process.exit(1);
  }

  // 4. Stage under ~/.nexus/.
  const nexusHome = process.env.NEXUS_HOME ?? join(homedir(), ".nexus");
  mkdirSync(nexusHome, { recursive: true });

  const stagedConfig = join(nexusHome, `${slug}.json`);
  if (resolve(configPath) !== resolve(stagedConfig)) {
    copyFileSync(configPath, stagedConfig);
    log.ok(`config staged at ${stagedConfig}`);
  }

  // 5. Download bundle from the gateway.
  const bundleUrl = deriveBundleUrl(server);
  const bundlePath = join(nexusHome, "nexus-bridge.js");

  log.info(`fetching bundle from ${bundleUrl}`);
  const ok = await downloadFile(bundleUrl, bundlePath);
  if (!ok) {
    log.err(`could not fetch bundle from ${bundleUrl}`);
    console.log(
      `\n  ${c.dim("Possible causes:")}\n` +
      `  • host gateway is offline / unreachable\n` +
      `  • the gateway hasn't run \`make build-bridge\` yet\n` +
      `  • the URL has a typo (must end with /bridge)\n`,
    );
    process.exit(1);
  }
  log.ok(`bundle saved (${(await Bun.file(bundlePath).size).toLocaleString()} bytes)`);

  // 6. Optional persistent install.
  if (args.persistent) {
    if (process.platform !== "linux") {
      log.warn("--persistent currently supports Linux/systemd only. Running in foreground instead.");
    } else {
      writeSystemdUnit({ slug, server, token, bundlePath, configPath: stagedConfig });
      return;
    }
  }

  // 7. Run bridge in foreground.
  console.log(`
${c.green(c.bold("✓ Bridge ready."))}

  ${c.bold("Slug:")}    ${slug}
  ${c.bold("Server:")}  ${server}
  ${c.bold("Config:")}  ${stagedConfig}
  ${c.bold("Bundle:")}  ${bundlePath}

  ${c.dim("Press Ctrl-C to stop.")}
`);

  const proc = spawn(["bun", bundlePath, "--config", stagedConfig, "--server", server], {
    env: { ...process.env, NEXUS_BRIDGE_TOKEN: token },
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
