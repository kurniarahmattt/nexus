// Minimal prompt helpers built on Node's readline — no extra deps.

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const hint = defaultValue ? ` [${defaultValue}]` : "";
    const ans = (await rl.question(`  ? ${question}${hint} `)).trim();
    return ans || defaultValue || "";
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const ans = (await ask(`${question} ${hint}`)).toLowerCase();
  if (!ans) return defaultYes;
  return ans === "y" || ans === "yes";
}
