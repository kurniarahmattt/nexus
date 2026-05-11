import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";

interface Config {
  slug: string;
  display_name: string;
  description: string;
  persona: string;
  model: string;
  cwd: string;
  cli: string;
  bridge_token: string;
  download: {
    display_name: string;
    description: string;
    persona: string;
    model: string;
    cwd: string;
  };
}

export default function BridgeEdit() {
  const { slug } = useParams<{ slug: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState<Config | null>(null);
  const [saved, setSaved] = useState(false);

  const q = useQuery<Config>({
    queryKey: ["bridge", slug],
    queryFn: () => api.get(`/me/bridges/${slug}/config`),
  });

  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);

  const mut = useMutation<{ ok: boolean }, Error, Partial<Config>>({
    mutationFn: (patch) => api.patch(`/me/bridges/${slug}`, patch),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      qc.invalidateQueries({ queryKey: ["bridge", slug] });
      qc.invalidateQueries({ queryKey: ["bridges"] });
    },
  });

  if (q.isLoading || !form) return <div className="text-slate-500">loading…</div>;

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    mut.mutate({
      display_name: form.display_name,
      description: form.description,
      persona: form.persona,
      model: form.model,
      cwd: form.cwd,
    });
  }

  function downloadConfig() {
    if (!form) return;
    const blob = new Blob(
      [JSON.stringify({ ...form.download, cli: form.cli }, null, 2)],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}.json`;
    a.click();
  }

  const serverHost = window.location.host;
  const cmd = `# 1. Install Bun (once, on user's PC):
curl -fsSL https://bun.sh/install | bash

# 2. Download nexus-bridge + your config:
curl -O http://${serverHost}/admin/download/nexus-bridge.js
# then download ${slug}.json from the button above

# 3. Run it (in one line):
NEXUS_BRIDGE_TOKEN=${form.bridge_token} \\
  bun nexus-bridge.js \\
    --config ./${slug}.json \\
    --server ws://${serverHost}/bridge`;

  return (
    <div className="max-w-3xl">
      <div className="flex justify-between items-baseline mb-4">
        <div>
          <h2 className="text-xl font-semibold">@{slug}</h2>
          <p className="text-sm text-slate-500">
            {form.cli} · {form.cwd}
          </p>
        </div>
        <button onClick={() => nav("/bridges")} className="text-sm text-slate-500">
          ← back
        </button>
      </div>

      <form onSubmit={save} className="space-y-4 bg-white border rounded-lg p-5">
        <Field label="Display name">
          <input
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Description">
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Model (optional — metadata only)">
          <input
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
            placeholder="leave blank — each CLI reads its own config"
            className="w-full border rounded px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-slate-500 mt-1">
            Nexus does <strong>not</strong> pass this to the CLI. Claude, Hermes,
            Cursor, and Gemini each pick their model from their own config on the
            user's PC. This field is just a label you can read here.
          </p>
        </Field>
        <Field label="CWD (absolute path on user's PC)">
          <input
            value={form.cwd}
            onChange={(e) => setForm({ ...form, cwd: e.target.value })}
            className="w-full border rounded px-3 py-2 text-sm font-mono"
          />
        </Field>
        <Field label="Persona (system prompt)">
          <textarea
            value={form.persona}
            onChange={(e) => setForm({ ...form, persona: e.target.value })}
            rows={14}
            className="w-full border rounded px-3 py-2 text-sm font-mono"
          />
        </Field>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={mut.isPending}
            className="bg-slate-900 text-white text-sm px-4 py-2 rounded disabled:opacity-40"
          >
            {mut.isPending ? "saving…" : "Save changes"}
          </button>
          {saved && <span className="text-emerald-600 text-sm">✓ saved</span>}
          {mut.error && <span className="text-red-600 text-sm">{mut.error.message}</span>}
          <span className="ml-auto text-xs text-emerald-700">
            ✓ Applies on next @mention — no restart needed.
          </span>
        </div>
      </form>

      <div className="mt-4 bg-sky-50 border border-sky-200 rounded-md p-3 text-sm text-sky-900">
        <strong>Where persona lives:</strong> Nexus server (DB) — UI is authoritative.
        Your local <code>{slug}.json</code> is only used as a seed on the first bridge
        connect; subsequent edits should happen here. The bridge fetches the latest
        persona from the server every time you are mentioned.
      </div>

      <div className="mt-6 bg-white border rounded-lg p-5 space-y-3">
        <h3 className="font-semibold text-slate-800">Connect this bridge</h3>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={downloadConfig}
            className="text-sm bg-slate-200 px-3 py-1.5 rounded"
          >
            ⇣ Download {slug}.json
          </button>
          <a
            href="/admin/download/nexus-bridge.js"
            download="nexus-bridge.js"
            className="text-sm bg-slate-200 px-3 py-1.5 rounded"
          >
            ⇣ Download nexus-bridge.js (~10 KB)
          </a>
        </div>
        <div>
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Bridge token
          </span>
          <code className="block bg-slate-900 text-emerald-300 px-3 py-2 rounded text-xs break-all">
            {form.bridge_token}
          </code>
        </div>
        <div>
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Command
          </span>
          <pre className="bg-slate-900 text-slate-100 text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap">
            {cmd}
          </pre>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
