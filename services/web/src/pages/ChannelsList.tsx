import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Channel } from "../api.ts";

export default function ChannelsList() {
  const q = useQuery<{ channels: Channel[] }>({
    queryKey: ["channels"],
    queryFn: () => api.get("/channels"),
  });
  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">Channels</h2>
        <Link
          to="/channels/new"
          className="bg-slate-900 text-white text-sm px-3 py-1.5 rounded-md"
        >
          + New channel
        </Link>
      </div>
      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs">
            <tr>
              <th className="text-left px-4 py-2">Name</th>
              <th className="text-left px-4 py-2">Kind</th>
              <th className="text-left px-4 py-2">Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {(q.data?.channels ?? []).map((ch) => (
              <tr key={ch.id}>
                <td className="px-4 py-2 font-mono text-slate-800">
                  {ch.kind === "dm" ? (
                    <span>
                      <span className="text-violet-600 mr-1">⇄</span>
                      {ch.name ?? "(dm)"}
                    </span>
                  ) : ch.kind === "private" ? (
                    <span>🔒 {ch.name}</span>
                  ) : (
                    <span>#{ch.name}</span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      ch.kind === "dm"
                        ? "bg-violet-100 text-violet-700"
                        : ch.kind === "private"
                          ? "bg-amber-100 text-amber-700"
                          : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {ch.kind}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">
                  {new Date(ch.created_at).toLocaleString()}
                </td>
                <td className="px-4 py-2 text-right">
                  {ch.kind !== "dm" && (
                    <Link
                      to={`/channels/${ch.rocketchat_rid}`}
                      className="text-sky-600 text-sm"
                    >
                      invite →
                    </Link>
                  )}
                </td>
              </tr>
            ))}
            {q.data?.channels.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  No channels yet. Create one or have an admin invite you.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
