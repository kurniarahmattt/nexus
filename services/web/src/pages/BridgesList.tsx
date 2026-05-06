import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Bridge } from "../api.ts";

export default function BridgesList() {
  const q = useQuery<{ bridges: Bridge[] }>({
    queryKey: ["bridges"],
    queryFn: () => api.get("/me/bridges"),
  });
  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">My Bridges</h2>
        <Link
          to="/bridges/new"
          className="bg-slate-900 text-white text-sm px-3 py-1.5 rounded-md"
        >
          + New bridge
        </Link>
      </div>
      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs">
            <tr>
              <th className="text-left px-4 py-2">Slug</th>
              <th className="text-left px-4 py-2">Display</th>
              <th className="text-left px-4 py-2">CLI</th>
              <th className="text-left px-4 py-2">CWD</th>
              <th className="text-left px-4 py-2">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {(q.data?.bridges ?? []).map((b) => (
              <tr key={b.slug}>
                <td className="px-4 py-2 font-mono text-slate-800">@{b.slug}</td>
                <td className="px-4 py-2">{b.display_name}</td>
                <td className="px-4 py-2 text-slate-500">{b.cli_kind}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-500 max-w-[220px] truncate">
                  {b.cwd}
                </td>
                <td className="px-4 py-2">
                  {b.is_connected ? (
                    <span className="text-emerald-600 text-xs">● online</span>
                  ) : (
                    <span className="text-slate-400 text-xs">○ offline</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <Link to={`/bridges/${b.slug}`} className="text-sky-600 text-sm">
                    edit
                  </Link>
                </td>
              </tr>
            ))}
            {q.data?.bridges.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  No bridges yet.{" "}
                  <Link to="/bridges/new" className="text-sky-600">
                    Create one
                  </Link>
                  .
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
