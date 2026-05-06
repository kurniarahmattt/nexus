import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type AdminUser, type UserCreds } from "../api.ts";

interface CreateResp {
  user: AdminUser;
  credentials: { auth_token: string; rc_password: string };
}

export default function AdminUsers() {
  const qc = useQueryClient();
  const users = useQuery<{ users: AdminUser[] }>({
    queryKey: ["admin-users"],
    queryFn: () => api.get("/admin/users"),
  });

  const [form, setForm] = useState({ username: "", display_name: "" });
  const [created, setCreated] = useState<CreateResp | null>(null);
  const [viewing, setViewing] = useState<UserCreds | null>(null);

  const create = useMutation<CreateResp, Error>({
    mutationFn: () => api.post("/admin/users", form),
    onSuccess: (data) => {
      setCreated(data);
      setForm({ username: "", display_name: "" });
      qc.invalidateQueries({ queryKey: ["admin-users"] });
    },
  });

  async function viewCreds(id: string) {
    const creds = await api.get<UserCreds>(`/admin/users/${id}/credentials`);
    setViewing(creds);
  }

  return (
    <div className="max-w-4xl">
      <h2 className="text-xl font-semibold mb-4">Admin — Users</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Validate before mutation so the user sees a clear error
          // instead of a silent HTML5 form reject.
          if (!/^[a-z0-9_-]{2,}$/.test(form.username)) {
            create.reset();
            (create as unknown as { setError?: (e: Error) => void }).setError?.(
              new Error("username must be lowercase alnum/underscore/dash, min 2 chars"),
            );
            return;
          }
          if (!form.display_name.trim()) return;
          create.mutate();
        }}
        className="bg-white border rounded-lg p-4 mb-4"
      >
        <div className="flex gap-3 items-end">
          <label className="flex-1">
            <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
              Username <span className="text-slate-400">(lowercase, a-z 0-9 _ -)</span>
            </span>
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
              required
              className="w-full border rounded px-3 py-2 text-sm font-mono"
              placeholder="alicedev"
            />
          </label>
          <label className="flex-1">
            <span className="block text-xs uppercase tracking-wide text-slate-500 mb-1">
              Display name
            </span>
            <input
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              required
              className="w-full border rounded px-3 py-2 text-sm"
              placeholder="Alice Dev"
            />
          </label>
          <button
            type="submit"
            disabled={create.isPending}
            className="bg-slate-900 text-white text-sm px-4 py-2 rounded disabled:opacity-40"
          >
            {create.isPending ? "creating…" : "+ Add user"}
          </button>
        </div>
        {create.error && (
          <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 px-3 py-2 rounded">
            Error: {create.error.message}
            {create.error.message === "username_exists" && (
              <span className="block text-xs mt-1">
                That username is already taken in Nexus or Rocket.Chat. Try another.
              </span>
            )}
            {create.error.message === "rc_create_failed" && (
              <span className="block text-xs mt-1">
                Rocket.Chat rejected the username. It might already exist in RC from
                a previous test. Check at Rocket.Chat admin or pick a different name.
              </span>
            )}
          </div>
        )}
      </form>

      {created && (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-4 mb-6 space-y-2 text-sm">
          <div className="font-semibold">
            User created: @{created.user.username}
          </div>
          <div>
            Nexus token:
            <code className="block bg-slate-900 text-emerald-300 px-2 py-1 rounded text-xs break-all mt-1">
              {created.credentials.auth_token}
            </code>
          </div>
          <div>
            Rocket.Chat password:
            <code className="block bg-slate-900 text-emerald-300 px-2 py-1 rounded text-xs break-all mt-1">
              {created.credentials.rc_password}
            </code>
          </div>
          <button
            onClick={() => setCreated(null)}
            className="text-xs text-slate-500 underline"
          >
            dismiss
          </button>
        </div>
      )}

      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs">
            <tr>
              <th className="text-left px-4 py-2">Username</th>
              <th className="text-left px-4 py-2">Name</th>
              <th className="text-left px-4 py-2">Role</th>
              <th className="text-left px-4 py-2">Last login</th>
              <th></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {(users.data?.users ?? []).map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-2 font-mono">@{u.username}</td>
                <td className="px-4 py-2">{u.display_name}</td>
                <td className="px-4 py-2">
                  <span
                    className={`text-xs px-2 py-0.5 rounded ${
                      u.role === "admin"
                        ? "bg-violet-100 text-violet-700"
                        : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {u.role}
                  </span>
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">
                  {u.last_login_at
                    ? new Date(u.last_login_at).toLocaleString()
                    : "—"}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    onClick={() => viewCreds(u.id)}
                    className="text-sky-600 text-sm"
                  >
                    creds
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {viewing && (
        <div className="fixed inset-0 bg-black/40 grid place-items-center">
          <div className="bg-white rounded-lg p-6 max-w-md w-full space-y-3">
            <h3 className="font-semibold">Credentials: @{viewing.username}</h3>
            <div>
              <span className="block text-xs text-slate-500 mb-1">Nexus token</span>
              <code className="block bg-slate-900 text-emerald-300 px-2 py-1 rounded text-xs break-all">
                {viewing.auth_token ?? "—"}
              </code>
            </div>
            <div>
              <span className="block text-xs text-slate-500 mb-1">RC password</span>
              <code className="block bg-slate-900 text-emerald-300 px-2 py-1 rounded text-xs break-all">
                {viewing.rc_password ?? "—"}
              </code>
            </div>
            <button
              onClick={() => setViewing(null)}
              className="w-full bg-slate-900 text-white py-2 rounded text-sm"
            >
              close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
