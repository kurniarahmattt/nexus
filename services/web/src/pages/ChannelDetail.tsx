import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";

interface Member {
  username: string;
  display_name: string | null;
  kind: string; // "human" | "bot:shared" | "bot:remote"
}

export default function ChannelDetail() {
  const { rid } = useParams<{ rid: string }>();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const search = useQuery<{ humans: Member[]; bots: Member[] }>({
    queryKey: ["members-search", q],
    queryFn: () =>
      api.get(`/channels/search-members?q=${encodeURIComponent(q)}`),
  });

  const invite = useMutation<
    { ok: boolean; results: Record<string, boolean> },
    Error
  >({
    mutationFn: () =>
      api.post(`/channels/${rid}/invite`, { usernames: [...selected] }),
    onSuccess: () => {
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["channels"] });
    },
  });

  function toggle(u: string) {
    const next = new Set(selected);
    if (next.has(u)) next.delete(u);
    else next.add(u);
    setSelected(next);
  }

  const all = [
    ...(search.data?.humans ?? []),
    ...(search.data?.bots ?? []),
  ];

  return (
    <div className="max-w-xl">
      <h2 className="text-xl font-semibold mb-1">Invite to channel</h2>
      <p className="text-sm text-slate-600 mb-4 font-mono">{rid}</p>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search humans or bots (blank = show all)…"
        className="w-full border rounded px-3 py-2 text-sm mb-3"
      />

      <div className="bg-white border rounded-lg max-h-96 overflow-y-auto">
        {all.length === 0 && (
          <div className="p-4 text-slate-400 text-sm">No matches.</div>
        )}
        {all.map((m) => (
          <label
            key={`${m.kind}-${m.username}`}
            className="flex items-center gap-3 px-4 py-2 border-b cursor-pointer hover:bg-slate-50"
          >
            <input
              type="checkbox"
              checked={selected.has(m.username)}
              onChange={() => toggle(m.username)}
            />
            <div className="flex-1">
              <div className="text-sm font-mono">
                @{m.username}
                {m.kind.startsWith("bot") && (
                  <span className="ml-2 text-xs text-violet-600">bot</span>
                )}
              </div>
              {m.display_name && (
                <div className="text-xs text-slate-500">{m.display_name}</div>
              )}
            </div>
          </label>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={() => invite.mutate()}
          disabled={selected.size === 0 || invite.isPending}
          className="bg-slate-900 text-white text-sm px-4 py-2 rounded disabled:opacity-40"
        >
          {invite.isPending ? "inviting…" : `Invite ${selected.size} selected`}
        </button>
        {invite.data?.results && (
          <span className="text-sm text-slate-600">
            {Object.values(invite.data.results).filter(Boolean).length} invited,{" "}
            {Object.values(invite.data.results).filter((x) => !x).length} failed
          </span>
        )}
      </div>
    </div>
  );
}
