import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";

import { c, log } from "../lib/colors.ts";
import { ask, confirm } from "../lib/prompt.ts";

interface PersonaArgs {
  slug?: string;
  field?: string;       // 'persona' | 'display_name' | 'description' | 'model'
  value?: string;       // when set, non-interactive update
  edit?: boolean;       // open $EDITOR instead of prompt
  show?: boolean;       // just print current values, no edit
}

function parseArgs(argv: string[]): PersonaArgs {
  const args: PersonaArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case "--field": args.field = next; i++; break;
      case "--value": args.value = next; i++; break;
      case "--edit":  args.edit = true; break;
      case "--show":  args.show = true; break;
      case "-h": case "--help": printHelp(); process.exit(0);
      default:
        if (a.startsWith("-")) {
          log.err(`unknown arg: ${a}`); printHelp(); process.exit(2);
        }
        if (!args.slug) args.slug = a;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`${c.bold("nexus persona")} — view or edit a bridge's persona / display name

${c.bold("Usage:")}
  nexus persona <slug>                       ${c.dim("# interactive: pick field to edit")}
  nexus persona <slug> --show                ${c.dim("# print current values, exit")}
  nexus persona <slug> --edit                ${c.dim("# open persona in \$EDITOR")}
  nexus persona <slug> --field <name> --value <text>   ${c.dim("# non-interactive")}

${c.bold("Editable fields:")}
  persona         The system prompt the CLI sees on every invocation.
  display_name    What teammates see in chat (RC profile is also updated).
  description     One-liner shown in admin listings.
  model           Model hint (e.g. sonnet-4-6, gpt-4o).

${c.bold("How it works:")}
  Edits ~/.nexus/<slug>.json on this laptop, then prompts whether to
  restart the bridge so the new values propagate to the host on the
  next 'hello' frame. The host stores them in agents.config and (for
  display_name) syncs the bot's Rocket.Chat profile.

${c.bold("Examples:")}
  nexus persona claude-alice-backend
  nexus persona claude-alice-backend --show
  nexus persona claude-alice-backend --field display_name --value "Alice's API specialist"
  nexus persona claude-alice-backend --edit
`);
}

export async function persona(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.slug) {
    log.err("slug required");
    printHelp();
    process.exit(2);
  }

  const nexusHome = process.env.NEXUS_HOME ?? join(homedir(), ".nexus");
  const configPath = join(nexusHome, `${args.slug}.json`);
  if (!existsSync(configPath)) {
    log.err(`config not found: ${configPath}`);
    log.info(`expected one of: ${listAvailableConfigs(nexusHome) || "(none)"}`);
    process.exit(1);
  }

  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;

  if (args.show) {
    showConfig(args.slug, configPath, cfg);
    return;
  }

  if (args.edit) {
    await openInEditor(configPath);
    log.ok("file edited");
    await maybeRestart(args.slug);
    return;
  }

  if (args.field && args.value !== undefined) {
    if (!isEditable(args.field)) {
      log.err(`field ${args.field} is not editable. See --help.`);
      process.exit(2);
    }
    cfg[args.field] = args.value;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    log.ok(`${args.field} updated in ${configPath}`);
    await maybeRestart(args.slug);
    return;
  }

  // Interactive: pick a field, prompt for new value.
  showConfig(args.slug, configPath, cfg);
  console.log();
  const which = (await ask("Which field to edit? [persona/display_name/description/model/cancel]", "persona")).toLowerCase();
  if (which === "cancel" || !which) {
    log.info("cancelled");
    return;
  }
  if (!isEditable(which)) {
    log.err(`unknown field: ${which}`);
    process.exit(2);
  }
  if (which === "persona") {
    log.info("opening persona in your $EDITOR — save & quit to apply");
    // Materialize current persona to a temp file, edit, read back.
    const tmp = `/tmp/nexus-persona-${args.slug}-${Date.now()}.txt`;
    writeFileSync(tmp, String(cfg.persona ?? ""));
    await openInEditor(tmp);
    cfg.persona = readFileSync(tmp, "utf8").replace(/\s+$/, "");
  } else {
    const newVal = await ask(`New ${which}`, String(cfg[which] ?? ""));
    cfg[which] = newVal;
  }
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  log.ok(`updated ${which}`);
  await maybeRestart(args.slug);
}

function isEditable(field: string): boolean {
  return ["persona", "display_name", "description", "model"].includes(field);
}

function showConfig(slug: string, path: string, cfg: Record<string, unknown>): void {
  console.log(`
${c.bold("Bridge:")}        ${slug}
${c.bold("Config file:")}   ${path}

  ${c.bold("display_name:")}  ${String(cfg.display_name ?? "(unset)")}
  ${c.bold("description:")}   ${String(cfg.description ?? "(unset)")}
  ${c.bold("model:")}         ${String(cfg.model ?? "(unset)")}
  ${c.bold("persona:")}       ${truncate(String(cfg.persona ?? "(unset)"), 200)}
`);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + c.dim(` … (+${s.length - n} chars)`);
}

function listAvailableConfigs(dir: string): string {
  if (!existsSync(dir)) return "";
  const { readdirSync } = require("node:fs");
  return readdirSync(dir).filter((f: string) => f.endsWith(".json")).join(", ");
}

async function openInEditor(path: string): Promise<void> {
  const editor = process.env.VISUAL ?? process.env.EDITOR ?? "nano";
  const proc = spawn([editor, path], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    log.warn(`editor exited with code ${proc.exitCode}`);
  }
}

async function maybeRestart(slug: string): Promise<void> {
  console.log(`\n  ${c.dim("changes are saved to ~/.nexus/" + slug + ".json")}`);
  console.log(`  ${c.dim("they take effect on the host the next time the bridge sends 'hello'")}\n`);
  const yes = await confirm("Restart the bridge now to push the changes?", true);
  if (!yes) {
    log.info(`run later: nexus onboard https://<host>/join/<code>  (or restart your existing bridge process)`);
    return;
  }
  // Try systemd user unit first.
  if (process.platform === "linux") {
    const units = await spawn(["systemctl", "--user", "list-units", "--all", "--no-legend", `nexus-bridge@${slug}.service`], {
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(units.stdout).text();
    await units.exited;
    if (out.includes(`nexus-bridge@${slug}.service`)) {
      log.info(`restarting systemd unit: nexus-bridge@${slug}`);
      const r = spawn(["systemctl", "--user", "restart", `nexus-bridge@${slug}.service`], {
        stdout: "inherit", stderr: "inherit",
      });
      await r.exited;
      if (r.exitCode === 0) {
        log.ok("bridge restarted via systemd");
        return;
      }
    }
  }
  log.warn("no systemd unit detected for this bridge.");
  log.info("if you're running the bridge in a tmux/screen session, send Ctrl-C and re-run `nexus onboard <url>`.");
}
