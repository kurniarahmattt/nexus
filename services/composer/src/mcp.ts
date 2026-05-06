/**
 * Fetch enabled MCP servers and build the mcpConfig shape expected by the
 * Claude Code / Cursor Agent CLI `--mcp-config` flag.
 */

import { pool } from "./db.ts";
import type { McpConfig } from "@nexus/schema";

export async function buildMcpConfig(): Promise<McpConfig | undefined> {
  const { rows } = await pool.query<{
    slug: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  }>(
    `SELECT slug, command, args, env FROM mcp_servers WHERE enabled = true`,
  );
  if (rows.length === 0) return undefined;
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  for (const r of rows) {
    mcpServers[r.slug] = {
      command: r.command,
      args: r.args ?? [],
      env: r.env ?? {},
    };
  }
  return { mcpServers };
}
