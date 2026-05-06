import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type Me } from "../api.ts";

export default function Profile({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [display, setDisplay] = useState(me.display_name ?? "");
  const [username, setUsername] = useState(me.username);
  const [saved, setSaved] = useState(false);

  const mut = useMutation<
    { ok: boolean; user: Me },
    Error,
    { display_name?: string; username?: string }
  >({
    mutationFn: (body) => api.patch("/me", body),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const patch: { display_name?: string; username?: string } = {};
    if (display !== (me.display_name ?? "")) patch.display_name = display;
    if (username !== me.username) patch.username = username;
    if (Object.keys(patch).length === 0) return;
    mut.mutate(patch);
  }

  const usernameChanged = username !== me.username;

  return (
    <div className="max-w-xl">
      <h2 className="text-xl font-semibold mb-1">My Profile</h2>
      <p className="text-sm text-slate-600 mb-5">
        Shown to teammates in chat and on the Nexus admin UI.
      </p>

      <form onSubmit={submit} className="bg-white border rounded-lg p-5 space-y-4">
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Display name
          </span>
          <input
            value={display}
            onChange={(e) => setDisplay(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm"
          />
        </label>

        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Username <span className="text-slate-400">(lowercase, a-z 0-9 _ -)</span>
          </span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            pattern="[a-z0-9_-]{2,}"
            className="w-full border rounded px-3 py-2 text-sm font-mono"
          />
        </label>

        {usernameChanged && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            <strong>Heads up:</strong> changing your username renames you everywhere
            (chat + Nexus UI) but your existing bridge slugs keep the OLD username
            (e.g. <code>claude-{me.username}-backend</code>). They'll still work —
            they just won't auto-rename.
          </div>
        )}

        <div>
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Role
          </span>
          <span className="inline-block text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700">
            {me.role}
          </span>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={mut.isPending}
            className="bg-slate-900 text-white text-sm px-4 py-2 rounded disabled:opacity-40"
          >
            {mut.isPending ? "saving…" : "Save"}
          </button>
          {saved && <span className="text-emerald-600 text-sm">✓ saved</span>}
          {mut.error && (
            <span className="text-red-600 text-sm">
              {mut.error.message === "username_exists"
                ? "That username is already taken."
                : mut.error.message}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
