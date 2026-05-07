import { c, log } from "../lib/colors.ts";
import { ask } from "../lib/prompt.ts";

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

  console.log(`
${c.bold("Requesting a new bridge.")}

  Invite: ${maskUrl(args.inviteUrl)}
  Slug:   ${args.cli}-${args.username}-${args.name}
  Cwd:    ${args.cwd}
`);

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

  const payload = await res.json() as { ok: true; slug: string; join_url: string; join_expires_at: string };
  log.ok(`bridge created: ${c.bold(payload.slug)}`);
  log.ok(`join URL issued (expires ${payload.join_expires_at}):`);
  console.log(`\n  ${c.cyan(payload.join_url)}\n`);

  if (args.autoJoin) {
    log.info("--auto-join set, running `nexus onboard` now...");
    const { onboard } = await import("./onboard.ts");
    await onboard([payload.join_url, ...(args.allowInsecure ? ["--allow-insecure"] : [])]);
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
