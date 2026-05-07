import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "bun";

import { c, log } from "../lib/colors.ts";
import { ask, confirm } from "../lib/prompt.ts";

const REPO_URL = "https://github.com/kurniarahmattt/nexus.git";

export async function hostOnboard(_args: string[]): Promise<void> {
  console.log(`
${c.bold("Welcome to Nexus host setup.")}

This wizard will set up Nexus as the team host on this machine. The full
setup takes 5–10 minutes for a fresh install.

If you only want your local AI partner to ${c.cyan("JOIN")} an existing Nexus
host run by someone else, exit now and use ${c.cyan("`nexus onboard`")} instead.
`);

  // 1. Locate or create the Nexus checkout.
  let repoDir: string;

  if (await isInsideNexusCheckout(process.cwd())) {
    log.ok(`detected Nexus checkout at ${process.cwd()}`);
    repoDir = process.cwd();
  } else {
    repoDir = await cloneOrReuseRepo();
  }

  // 2. Hand off to the canonical onboarding script.
  log.info(`running scripts/onboard.sh in ${repoDir}`);
  const proc = spawn(["bash", join(repoDir, "scripts/onboard.sh")], {
    cwd: repoDir,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  process.exit(proc.exitCode ?? 0);
}

async function isInsideNexusCheckout(dir: string): Promise<boolean> {
  return (
    existsSync(join(dir, "Makefile")) &&
    existsSync(join(dir, "scripts/onboard.sh")) &&
    existsSync(join(dir, "docker-compose.yml")) &&
    existsSync(join(dir, "package.json"))
  );
}

async function cloneOrReuseRepo(): Promise<string> {
  const defaultDir = resolve(homedir(), "coding", "nexus");
  const wanted = await ask(
    `Where would you like to install Nexus?`,
    defaultDir,
  );
  const dir = resolve(wanted);

  if (existsSync(dir)) {
    if (await isInsideNexusCheckout(dir)) {
      log.ok(`reusing existing Nexus checkout at ${dir}`);
      return dir;
    }
    if (existsSync(join(dir, ".git"))) {
      log.err(
        `${dir} is a git repo but doesn't look like Nexus. Pick a different path.`,
      );
      process.exit(1);
    }
    const { readdirSync } = await import("node:fs");
    if (readdirSync(dir).length > 0) {
      log.err(
        `${dir} exists and is non-empty. Pick an empty / new directory.`,
      );
      process.exit(1);
    }
  } else {
    mkdirSync(dir, { recursive: true });
  }

  if (!(await commandExists("git"))) {
    log.err("git is required to clone the Nexus repo. Install git and re-run.");
    process.exit(1);
  }

  const proceed = await confirm(
    `Clone ${REPO_URL} into ${dir}?`,
    true,
  );
  if (!proceed) {
    log.warn("aborted by user");
    process.exit(0);
  }

  log.info(`cloning ${REPO_URL} → ${dir}`);
  const proc = spawn(["git", "clone", REPO_URL, dir], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    log.err("git clone failed");
    process.exit(proc.exitCode ?? 1);
  }
  log.ok(`cloned to ${dir}`);
  return dir;
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
