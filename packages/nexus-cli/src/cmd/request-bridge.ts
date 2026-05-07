import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { spawn } from "bun";

import { c, log } from "../lib/colors.ts";
import { ask, confirm } from "../lib/prompt.ts";

interface RequestBridgeArgs {
  inviteUrl?: string;
  name?: string;
  cwd?: string;
  cli?: string;
  username?: string;
  persona?: string;
  displayName?: string;
  description?: string;
  model?: string;
  autoJoin?: boolean;
  allowInsecure?: boolean;
  persistent?: boolean;
}

function parseArgs(argv: string[]): RequestBridgeArgs {
  const args: RequestBridgeArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case "--name":           args.name = next; i++; break;
      case "--cwd":            args.cwd = next;  i++; break;
      case "--cli":            args.cli = next;  i++; break;
      case "--username":       args.username = next; i++; break;
      case "--persona":        args.persona = next; i++; break;
      case "--display-name":   args.displayName = next; i++; break;
      case "--description":    args.description = next; i++; break;
      case "--model":          args.model = next; i++; break;
      case "--auto-join":      args.autoJoin = true; break;
      case "--allow-insecure": args.allowInsecure = true; break;
      case "--persistent":     args.persistent = true; break;
      case "--no-persistent":  args.persistent = false; break;
      case "-h": case "--help": printHelp(); process.exit(0);
      default:
        if (a.startsWith("-")) {
          log.err(`unknown arg: ${a}`);
          printHelp(); process.exit(2);
        }
        if (/^https?:\/\//.test(a) && !args.inviteUrl) args.inviteUrl = a;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`${c.bold("nexus request-bridge")} — create a new bridge for yourself using an admin invite

${c.bold("Usage:")}
  nexus request-bridge <invite-url> --name <role> --cwd <path> [options]

${c.bold("Required:")}
  <invite-url>          Invite URL from your admin (https://nexus.team.com/invite/...)
  --name <role>         Slug suffix — your role on this bridge (e.g. backend, infra)
  --cwd <path>          Absolute path to the project directory on your laptop

${c.bold("Optional:")}
  --cli <kind>          claude (default) | cursor | gemini | hermes
  --username <name>     Your username (defaults to \$USER from the environment)
  --persona <text>      Initial persona / system prompt
  --display-name <s>    Initial display name shown in chat
  --description <s>     One-line description for admin listings
  --model <s>           Model identifier hint (e.g. sonnet-4-6)
  --auto-join           After the invite is consumed, immediately run
                        \`nexus onboard\` with the issued join URL.
  --persistent          Register a systemd user unit so the bridge auto-
                        starts on boot (Linux only). Asked interactively
                        if not provided.
  --no-persistent       Skip the persistence prompt (always foreground).
  --allow-insecure      Allow plaintext http:// invite URLs (NOT recommended)
  -h, --help            Show this help

${c.bold("Examples:")}
  nexus request-bridge https://nexus.team.com/invite/aBC123 \\
    --name backend --cwd /home/alice/work/api

  nexus request-bridge https://nexus.team.com/invite/aBC123 \\
    --name infra --cwd /home/alice/work/deploy --cli cursor --auto-join
`);
}

export async function requestBridge(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (!args.inviteUrl) args.inviteUrl = await ask("Paste the invite URL");
  if (!args.inviteUrl) { log.err("invite URL required"); process.exit(2); }

  if (!args.inviteUrl.startsWith("https://") && !args.allowInsecure) {
    if (args.inviteUrl.startsWith("http://")) {
      log.err("plaintext http:// invite URL refused. Pass --allow-insecure for LAN-only deploys.");
      process.exit(1);
    }
    log.err(`invalid invite URL: ${args.inviteUrl}`);
    process.exit(2);
  }

  console.log(`${c.bold("Step 1 — basic identity")}\n`);
  if (!args.name) args.name = await ask("Role / suffix for this bridge (e.g. backend)");
  if (!args.cwd)  args.cwd  = await ask("Absolute path to your project on this laptop");
  if (!args.cli)  args.cli  = (await ask("CLI to wrap (claude/cursor/gemini/hermes)", "claude")) || "claude";
  if (!args.username) args.username = process.env.USER ?? await ask("Your username");

  if (!args.cwd?.startsWith("/")) {
    log.err(`--cwd must be an absolute path (got: ${args.cwd})`);
    process.exit(2);
  }
  if (!/^[a-z0-9-]+$/.test(args.name ?? "")) {
    log.err(`--name must match [a-z0-9-]+ (got: ${args.name})`);
    process.exit(2);
  }
  if (!/^[a-z0-9_-]+$/.test(args.username ?? "")) {
    log.err(`--username must match [a-z0-9_-]+ (got: ${args.username})`);
    process.exit(2);
  }

  // ── Verify the wrapped CLI is installed before we make a server-side bridge.
  await verifyWrappedCli(args.cli!);

  const slug = `${args.cli}-${args.username}-${args.name}`;
  console.log(`\n${c.bold("Step 2 — chat appearance")} ${c.dim(`(skip any prompt to keep the default)`)}\n`);

  if (!args.displayName) {
    const defaultName = `${args.cli![0]!.toUpperCase()}${args.cli!.slice(1)} (${args.username}-${args.name})`;
    args.displayName = await ask("Display name (shown in chat)", defaultName);
  }
  if (!args.description) {
    args.description = await ask("One-line description (admin listings)", "");
  }

  console.log(`\n${c.bold("Step 3 — persona (system prompt)")}\n`);
  if (!args.persona) {
    args.persona = await promptPersonaInteractive(slug, args.cli!, args.username!, args.name!, args.cwd!);
  }

  if (args.persistent === undefined) {
    if (process.platform === "linux") {
      console.log(`\n${c.bold("Step 4 — persistence")}\n`);
      args.persistent = await confirm(
        "Auto-start this bridge on boot? (registers a systemd user unit you can manage with systemctl)",
        false,
      );
    } else {
      args.persistent = false;
    }
  }

  console.log(`\n${c.bold("Submitting...")}\n`);
  console.log(`  Invite:        ${maskUrl(args.inviteUrl)}`);
  console.log(`  Slug:          ${slug}`);
  console.log(`  Cwd:           ${args.cwd}`);
  console.log(`  Display name:  ${args.displayName || "(default)"}`);
  console.log(`  Description:   ${args.description || "(none)"}`);
  console.log(`  Persona:       ${args.persona ? `${args.persona.length} chars` : "(default)"}`);
  console.log(`  Persistent:    ${args.persistent ? "yes (systemd unit)" : "no (foreground)"}`);
  console.log();

  log.info("submitting request to gateway...");
  const res = await fetch(args.inviteUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "nexus-cli/0.1" },
    body: JSON.stringify({
      name: args.name,
      cwd: args.cwd,
      cli: args.cli,
      username: args.username,
      ...(args.persona ? { persona: args.persona } : {}),
      ...(args.displayName ? { display_name: args.displayName } : {}),
      ...(args.description ? { description: args.description } : {}),
      ...(args.model ? { model: args.model } : {}),
    }),
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string; detail?: string; allowed?: string[]; required_prefix?: string };
      if (body.error) msg = body.error;
      if (body.detail) msg += `: ${body.detail}`;
      if (body.allowed) msg += ` (allowed CLIs: ${body.allowed.join(", ")})`;
      if (body.required_prefix) msg += ` (required prefix: ${body.required_prefix})`;
    } catch { /* keep generic */ }
    log.err(`request rejected: ${msg}`);
    process.exit(1);
  }

  const payload = await res.json() as {
    ok: true;
    slug: string;
    join_url: string;
    join_expires_at: string;
    channels_invited?: Record<string, boolean>;
  };
  log.ok(`bridge created: ${c.bold(payload.slug)}`);

  if (payload.channels_invited && Object.keys(payload.channels_invited).length > 0) {
    for (const [ch, ok] of Object.entries(payload.channels_invited)) {
      if (ok) log.ok(`auto-invited to #${ch}`);
      else    log.warn(`auto-invite to #${ch} failed (admin can retry: make invite-bot SLUG=${payload.slug} CHANNEL=${ch})`);
    }
  }

  log.ok(`join URL issued (expires ${payload.join_expires_at})`);

  if (args.autoJoin) {
    log.info("connecting bridge now...");
    const { onboard } = await import("./onboard.ts");
    const onboardArgs = [
      payload.join_url,
      ...(args.allowInsecure ? ["--allow-insecure"] : []),
      ...(args.persistent ? ["--persistent"] : []),
    ];
    await onboard(onboardArgs);
    return;
  }

  console.log(
    `  Next: ${c.cyan(`nexus onboard ${payload.join_url}`)}\n\n` +
    `  ${c.dim("(or pass --auto-join to this command to skip the manual step)")}\n`,
  );
}

function maskUrl(url: string): string {
  return url.replace(/\/invite\/[^/?#]+/, "/invite/<code-redacted>");
}

// ── Verify the wrapped CLI is on $PATH before calling the host. ────────
async function verifyWrappedCli(kind: string): Promise<void> {
  // Map slug-kind → expected binary name. Bridge users typically spawn
  // these directly on their laptop.
  const bin: Record<string, string> = {
    claude: "claude",
    cursor: "cursor-agent",
    gemini: "gemini",
    hermes: "hermes",
  };
  const expected = bin[kind] ?? kind;

  const proc = spawn(["which", expected], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  if (proc.exitCode === 0) {
    log.ok(`${expected} found in \$PATH`);
    return;
  }

  log.err(`${expected} is NOT in \$PATH on this machine.`);
  console.log(`\n  Bridges run the CLI on YOUR laptop. Without ${c.cyan(expected)} installed,`);
  console.log(`  the bot will fail every invocation. Install hint:\n`);
  const hints: Record<string, string> = {
    claude:       "  https://docs.anthropic.com/claude/docs/claude-code",
    cursor:       "  https://cursor.com/cli",
    "cursor-agent":"  https://cursor.com/cli",
    gemini:       "  https://github.com/google-gemini/gemini-cli",
    hermes:       "  (vendor-specific — install per your team's instructions)",
  };
  console.log(hints[kind] ?? hints[expected] ?? "  (install per the CLI's own docs)");
  console.log();

  const proceed = await confirm("Continue anyway and install later?", false);
  if (!proceed) {
    log.info("aborted. Install the CLI and re-run `nexus onboard <invite-url>`.");
    process.exit(1);
  }
}

// ── Open $EDITOR with a persona template, return the saved text. ───────
async function promptPersonaInteractive(
  slug: string,
  cli: string,
  username: string,
  name: string,
  cwd: string,
): Promise<string | undefined> {
  const wantCustom = await confirm(
    "Customize the persona (system prompt) now? (otherwise a generic default is used; you can edit later with `nexus persona`)",
    true,
  );
  if (!wantCustom) return undefined;

  const template =
    `You are @${slug}, a Nexus bridge bot owned by ${username}. ` +
    `You wrap the ${cli} CLI on their machine, scoped to ${cwd}.\n\n` +
    `## Operating rules\n\n` +
    `- Be concise. Match the user's language (English / Indonesian).\n` +
    `- The chat is multi-user — watch for the [TEAM CONTEXT] block for attribution.\n` +
    `- You may be addressed by other bots (e.g. @<cli>-<other-user>-<role>) — answer as a peer.\n\n` +
    `## Scope (edit this!)\n\n` +
    `- Describe what THIS bot is responsible for.\n` +
    `- Describe what to defer to peer bots (e.g. infra → @cursor-${username}-infra).\n\n` +
    `## Voice\n\n` +
    `- Default: terse, technical, no filler.\n`;

  const tmp = `/tmp/nexus-persona-${slug}-${Date.now()}.md`;
  writeFileSync(tmp, template);

  const editor = process.env.VISUAL ?? process.env.EDITOR ?? "nano";
  log.info(`opening persona template in ${editor} — save & quit when done…`);
  const proc = spawn([editor, tmp], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  await proc.exited;
  if (proc.exitCode !== 0) {
    log.warn(`editor exited with code ${proc.exitCode}; using template as-is`);
  }

  let persona: string;
  try {
    persona = readFileSync(tmp, "utf8").replace(/\s+$/, "");
  } catch {
    persona = template;
  }
  try { unlinkSync(tmp); } catch { /* best-effort cleanup */ }

  if (persona === template.replace(/\s+$/, "")) {
    log.warn("persona unchanged from template — recommend editing it before peers see your bot");
  }
  return persona;
}
