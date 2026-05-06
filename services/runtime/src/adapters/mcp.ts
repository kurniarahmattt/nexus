/**
 * Write the MCP config JSON to a temp file so the CLI can consume it via
 * --mcp-config. Caller is responsible for deleting the file after the
 * spawn; simplest pattern is to return { path, cleanup }.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpConfigShape } from "./types.ts";

export function writeMcpConfig(cfg: McpConfigShape): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "nexus-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(path, JSON.stringify(cfg, null, 2), "utf8");
  return {
    path,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}
