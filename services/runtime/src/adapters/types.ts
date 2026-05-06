export interface McpConfigShape {
  mcpServers: Record<
    string,
    { command: string; args: string[]; env: Record<string, string> }
  >;
}

export interface AdapterContext {
  /** Persona / overall system instructions. Empty string = use CLI default. */
  systemPrompt: string;
  /** User-facing prompt (attribution header + transcript + current task). */
  userPrompt: string;
  workingDirectory: string;
  timeoutMs: number;
  /** Phase 6: if provided, adapter writes temp file + passes --mcp-config. */
  mcpConfig?: McpConfigShape;
  /** Called every time new stdout chunk arrives (batched). */
  onChunk?: (accumulated: string) => void | Promise<void>;
}

export interface AdapterResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  durationMs: number;
  errorText?: string;
}

export interface Adapter {
  slug: string;
  run(ctx: AdapterContext): Promise<AdapterResult>;
}
