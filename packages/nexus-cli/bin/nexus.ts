#!/usr/bin/env bun
/**
 * Nexus CLI — single entry point.
 *
 * Subcommands:
 *   nexus host-onboard     Set up a Nexus host on this machine.
 *   nexus onboard          Join an existing Nexus instance as a bridge.
 *   nexus version          Print version.
 *   nexus help             Show this help.
 */

import { hostOnboard } from "../src/cmd/host-onboard.ts";
import { onboard } from "../src/cmd/onboard.ts";
import { requestBridge } from "../src/cmd/request-bridge.ts";
import { persona } from "../src/cmd/persona.ts";
import { c } from "../src/lib/colors.ts";

const VERSION = "0.1.0";

function usage(): void {
  console.log(`${c.bold("nexus")} — networked AI partners in your team chat
${c.dim(`version ${VERSION}`)}

${c.bold("Usage:")}
  nexus <command> [args]

${c.bold("Commands:")}
  ${c.cyan("host-onboard")}   Set up a Nexus host on this machine.
                 Walks you through prerequisites, secrets, docker, and
                 services. If you don't have a Nexus checkout yet, the
                 command will clone the repo for you.

  ${c.cyan("onboard")}        Join an existing Nexus instance as a bridge.
                 Run this on your laptop AFTER your team's host admin
                 has issued you a join URL. Downloads the bridge
                 bundle from the host and stays connected.

  ${c.cyan("request-bridge")} Use an admin invite to create a new bridge for
                 yourself (no admin involvement after invite is issued).
                 Picks slug + cwd + CLI within the invite's constraints,
                 then prints a join URL ready for \`nexus onboard\`.

  ${c.cyan("persona")}        View / edit a bridge's persona, display name, or
                 description on this laptop. Changes propagate to the
                 host on next bridge \`hello\` (the CLI offers to restart).

${c.bold("Other:")}
  nexus version  Print the CLI version.
  nexus help     Show this help.

${c.bold("More:")}
  Docs:        https://kurniarahmattt.github.io/nexus/
  Source:      https://github.com/kurniarahmattt/nexus
`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case "host-onboard":
      await hostOnboard(rest);
      break;
    case "onboard":
      await onboard(rest);
      break;
    case "request-bridge":
      await requestBridge(rest);
      break;
    case "persona":
      await persona(rest);
      break;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      break;
    default:
      console.error(`${c.red("✗")} unknown command: ${cmd}\n`);
      usage();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`${c.red("✗")} ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
