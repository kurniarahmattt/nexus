import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api.ts";

interface CreateResp {
  slug: string;
  bridge_token: string;
  config: {
    display_name: string;
    description: string;
    persona: string;
    model: string;
    cwd: string;
  };
}

export default function BridgeNew() {
  const nav = useNavigate();
  const [cli, setCli] = useState("claude");
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [persona, setPersona] = useState("");
  const [result, setResult] = useState<CreateResp | null>(null);

  const mut = useMutation<CreateResp, Error>({
    mutationFn: () =>
      api.post("/me/bridges", {
        cli,
        cwd,
        name: name || undefined,
        display_name: displayName || undefined,
        description: description || undefined,
        persona: persona || undefined,
      }),
    onSuccess: setResult,
  });

  function downloadConfig() {
    if (!result) return;
    const payload = JSON.stringify(
      { ...result.config, cli },
      null,
      2,
    );
    const blob = new Blob([payload], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${result.slug}.json`;
    a.click();
  }

  if (result) {
    const serverHost = window.location.host;
    const serverHostname = serverHost.split(":")[0];
    const exportCmd = `# 1. Install Bun (once, on user's PC):
curl -fsSL https://bun.sh/install | bash

# 2. Download nexus-bridge + your config:
curl -O http://${serverHost}/admin/download/nexus-bridge.js
# then download ${result.slug}.json below

# 3. Run it:
NEXUS_BRIDGE_TOKEN=${result.bridge_token} \\
  bun nexus-bridge.js \\
    --config ./${result.slug}.json \\
    --server ws://${serverHostname}:4000/bridge`;
    return (
      <div className="max-w-2xl space-y-4">
        <h2 className="text-xl font-semibold">Bridge created: @{result.slug}</h2>
        <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-sm text-amber-900">
          <strong>Save these now.</strong> The bridge token is shown only once.
        </div>

        <div className="bg-sky-50 border border-sky-200 rounded-md p-3 text-sm text-sky-900 space-y-1">
          <strong>Next steps:</strong>
          <ol className="list-decimal ml-5 space-y-0.5">
            <li>Download the config + nexus-bridge script below.</li>
            <li>Hand them to the user; they run the command on their PC.</li>
            <li>
              <strong>Invite <code>@{result.slug}</code> to a channel</strong> so it
              can participate —{" "}
              <a href="/admin/channels" className="underline text-sky-700">
                open Channels
              </a>
              , pick a channel, and add the bot.
            </li>
            <li>
              Edit persona/description anytime from <em>My Bridges → @
              {result.slug}</em>. Changes apply on the next @mention — no restart.
            </li>
          </ol>
        </div>

        <Field label="Bridge token">
          <code className="block bg-slate-900 text-emerald-300 px-3 py-2 rounded text-xs break-all">
            {result.bridge_token}
          </code>
        </Field>

        <Field label="Downloads (hand both to the user)">
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={downloadConfig}
              className="bg-slate-900 text-white text-sm px-3 py-1.5 rounded"
            >
              ⇣ {result.slug}.json
            </button>
            <a
              href="/admin/download/nexus-bridge.js"
              download="nexus-bridge.js"
              className="bg-slate-200 text-slate-900 text-sm px-3 py-1.5 rounded"
            >
              ⇣ nexus-bridge.js (~10 KB)
            </a>
          </div>
        </Field>

        <Field label="Run on user's PC">
          <pre className="bg-slate-900 text-slate-100 text-xs p-3 rounded overflow-x-auto whitespace-pre-wrap">
            {exportCmd}
          </pre>
        </Field>

        <div className="flex gap-3 pt-2">
          <button
            onClick={() => nav("/bridges")}
            className="text-sm text-slate-600 hover:underline"
          >
            Back to bridges
          </button>
          <button
            onClick={() => nav(`/bridges/${result.slug}`)}
            className="text-sm text-sky-600 hover:underline"
          >
            Edit persona →
          </button>
          <button
            onClick={() => nav("/channels")}
            className="text-sm text-sky-600 hover:underline ml-auto"
          >
            Invite to channel →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold mb-1">New Bridge</h2>
      <p className="text-sm text-slate-600 mb-6">
        Create a bot identity for a local AI CLI session on your PC.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          mut.mutate();
        }}
        className="space-y-4"
      >
        <Field label="CLI kind">
          <select
            value={cli}
            onChange={(e) => setCli(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm"
          >
            <option value="claude">claude (Claude Code)</option>
            <option value="hermes">hermes</option>
            <option value="cursor">cursor (Cursor Agent)</option>
            <option value="gemini">gemini</option>
          </select>
        </Field>

        <Field label="Session name (optional — suffix for slug)">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="backend"
            pattern="[a-z0-9][a-z0-9-]*"
            className="w-full border rounded px-3 py-2 text-sm font-mono"
          />
          <p className="text-xs text-slate-500 mt-1">
            Full slug will be <code>{cli}-&lt;you&gt;{name ? `-${name}` : ""}</code>.
          </p>
        </Field>

        <Field label="Display name">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={`${cli[0]?.toUpperCase()}${cli.slice(1)} (backend)`}
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </Field>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this session does in the team"
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </Field>

        <Field label="CWD on user's PC (absolute path)">
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            required
            placeholder="/home/rahmat/coding/nexus/backend"
            className="w-full border rounded px-3 py-2 text-sm font-mono"
          />
        </Field>

        <Field label="Persona (system prompt)">
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={8}
            placeholder="You are @... focused on ... Refuse ... When asked X, say Y. Be concise."
            className="w-full border rounded px-3 py-2 text-sm font-mono"
          />
        </Field>

        {mut.error && (
          <div className="text-sm text-red-600">Error: {mut.error.message}</div>
        )}
        <button
          type="submit"
          disabled={mut.isPending}
          className="bg-slate-900 text-white text-sm px-4 py-2 rounded disabled:opacity-40"
        >
          {mut.isPending ? "creating…" : "Create bridge"}
        </button>
      </form>
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
