// Tiny ANSI helpers — Bun has no chalk by default and we don't want a dep.

const ESC = "\x1b[";
const supported =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const wrap = (open: string, close: string) =>
  (s: string) =>
    supported ? `${ESC}${open}m${s}${ESC}${close}m` : s;

export const c = {
  reset: wrap("0", "0"),
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  cyan: wrap("36", "39"),
};

export const log = {
  step: (n: number, total: number, label: string) =>
    console.log(`\n${c.cyan(c.bold(`┌─[${n}/${total}]─ ${label}`))}`),
  ok:   (msg: string) => console.log(`  ${c.green("✓")} ${msg}`),
  warn: (msg: string) => console.log(`  ${c.yellow("!")} ${msg}`),
  err:  (msg: string) => console.error(`  ${c.red("✗")} ${msg}`),
  info: (msg: string) => console.log(`  ${c.dim(msg)}`),
  ask:  (msg: string) => process.stdout.write(`  ${c.blue("?")} ${msg} `),
};
