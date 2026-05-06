import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";

interface McpServer {
  id: string;
  slug: string;
  display_name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  description: string;
  enabled: boolean;
  created_at: string;
}

export default function AdminMcpServers() {
  const qc = useQueryClient();
  const list = useQuery<{ servers: McpServer[] }>({
    queryKey: ["mcp-servers"],
    queryFn: () => api.get("/admin/mcp-servers"),
  });

  const [form, setForm] = useState({
    slug: "",
    display_name: "",
    command: "",
    argsText: "",
    envText: "",
    description: "",
    enabled: false,
  });

  const create = useMutation<{ server: McpServer }, Error>({
    mutationFn: () =>
      api.post("/admin/mcp-servers", {
        slug: form.slug,
        display_name: form.display_name,
        command: form.command,
        args: form.argsText
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
        env: Object.fromEntries(
          form.envText
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((line) => {
              const idx = line.indexOf("=");
              return idx > 0
                ? [line.slice(0, idx), line.slice(idx + 1)]
                : [line, ""];
            }),
        ),
        description: form.description,
        enabled: form.enabled,
      }),
    onSuccess: () => {
      setForm({
        slug: "",
        display_name: "",
        command: "",
        argsText: "",
        envText: "",
        description: "",
        enabled: false,
      });
      qc.invalidateQueries({ queryKey: ["mcp-servers"] });
    },
  });

  const toggle = useMutation<{ ok: boolean }, Error, { id: string; enabled: boolean }>({
    mutationFn: ({ id, enabled }) =>
      api.patch(`/admin/mcp-servers/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });

  return (
    <div className="max-w-5xl">
      <h2 className="text-xl font-semibold mb-1">Admin — MCP Servers</h2>
      <p className="text-sm text-slate-600 mb-5">
        Tool backends exposed to all bots. When enabled, composer injects
        <code className="mx-1">--mcp-config</code> into every invocation.
        Claude &amp; Cursor adapters spawn these as subprocesses per invocation.
        Hermes and Gemini manage MCP via their own local config.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
        className="bg-white border rounded-lg p-4 mb-6 grid grid-cols-2 gap-3"
      >
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Slug (lowercase)
          </span>
          <input
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
            required
            pattern="[a-z0-9][a-z0-9-]*"
            className="w-full border rounded px-3 py-2 text-sm font-mono"
            placeholder="my-git-mcp"
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Display name
          </span>
          <input
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            required
            className="w-full border rounded px-3 py-2 text-sm"
            placeholder="Git (repo operations)"
          />
        </label>
        <label className="block col-span-2">
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Command
          </span>
          <input
            value={form.command}
            onChange={(e) => setForm({ ...form, command: e.target.value })}
            required
            className="w-full border rounded px-3 py-2 text-sm font-mono"
            placeholder="npx"
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Args (one per line)
          </span>
          <textarea
            value={form.argsText}
            onChange={(e) => setForm({ ...form, argsText: e.target.value })}
            rows={4}
            className="w-full border rounded px-3 py-2 text-sm font-mono"
            placeholder="-y&#10;@modelcontextprotocol/server-git&#10;/path/to/repo"
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Env (KEY=VALUE per line)
          </span>
          <textarea
            value={form.envText}
            onChange={(e) => setForm({ ...form, envText: e.target.value })}
            rows={4}
            className="w-full border rounded px-3 py-2 text-sm font-mono"
            placeholder="GITHUB_TOKEN=ghp_..."
          />
        </label>
        <label className="block col-span-2">
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Description
          </span>
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Enable immediately
        </label>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={create.isPending}
            className="bg-slate-900 text-white text-sm px-4 py-2 rounded disabled:opacity-40"
          >
            {create.isPending ? "adding…" : "+ Add server"}
          </button>
          {create.error && (
            <span className="text-red-600 text-sm">{create.error.message}</span>
          )}
        </div>
      </form>

      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className="text-left px-4 py-2">Slug</th>
              <th className="text-left px-4 py-2">Command</th>
              <th className="text-left px-4 py-2">Description</th>
              <th className="text-center px-4 py-2">Enabled</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {(list.data?.servers ?? []).map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-2 font-mono text-slate-800">{s.slug}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-600 max-w-[280px] truncate">
                  {s.command} {s.args.join(" ")}
                </td>
                <td className="px-4 py-2 text-slate-500 text-xs max-w-[240px]">
                  {s.description || "—"}
                </td>
                <td className="px-4 py-2 text-center">
                  <button
                    onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}
                    className={`text-xs px-3 py-1 rounded ${
                      s.enabled
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {s.enabled ? "● on" : "○ off"}
                  </button>
                </td>
              </tr>
            ))}
            {list.data?.servers.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  No MCP servers configured yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
