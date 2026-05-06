import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { api } from "../api.ts";

export default function ChannelNew() {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"channel" | "private">("channel");

  const mut = useMutation<
    { ok: boolean; rocketchat_rid: string; name: string },
    Error
  >({
    mutationFn: () => api.post("/channels", { name, kind, members: [] }),
    onSuccess: (data) => nav(`/channels/${data.rocketchat_rid}`),
  });

  return (
    <div className="max-w-md">
      <h2 className="text-xl font-semibold mb-1">New Channel</h2>
      <p className="text-sm text-slate-600 mb-6">
        Creates a Rocket.Chat channel/group and registers it in Nexus.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mut.mutate();
        }}
        className="space-y-4 bg-white border rounded-lg p-5"
      >
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            pattern="[a-z0-9][a-z0-9-]*"
            required
            placeholder="project-nexus"
            className="w-full border rounded px-3 py-2 text-sm font-mono"
          />
        </label>
        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
            Kind
          </span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "channel" | "private")}
            className="w-full border rounded px-3 py-2 text-sm"
          >
            <option value="channel">Public channel</option>
            <option value="private">Private group</option>
          </select>
        </label>
        {mut.error && <div className="text-sm text-red-600">{mut.error.message}</div>}
        <button
          disabled={mut.isPending || name.length < 2}
          className="bg-slate-900 text-white text-sm px-4 py-2 rounded disabled:opacity-40"
        >
          {mut.isPending ? "creating…" : "Create channel"}
        </button>
      </form>
    </div>
  );
}
