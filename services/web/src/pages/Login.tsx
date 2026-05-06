import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api.ts";

export default function Login() {
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api.post("/auth/login", { token });
      await qc.invalidateQueries({ queryKey: ["me"] });
      nav("/");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen grid place-items-center bg-slate-100">
      <form onSubmit={submit} className="bg-white shadow rounded-lg p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-slate-900 mb-1">N.E.X.U.S</h1>
        <p className="text-sm text-slate-500 mb-6">
          Paste your Nexus token to sign in.
        </p>
        <input
          type="password"
          autoFocus
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="nexus-token"
          className="w-full border border-slate-300 rounded-md px-3 py-2 text-sm font-mono mb-3"
        />
        {err && <div className="text-sm text-red-600 mb-3">Error: {err}</div>}
        <button
          disabled={busy || token.length < 16}
          className="w-full bg-slate-900 text-white text-sm font-medium py-2 rounded-md disabled:opacity-40"
        >
          {busy ? "signing in…" : "Sign in"}
        </button>
        <p className="text-xs text-slate-400 mt-4">
          Admin: get your token from the <code>NEXUS_ADMIN_TOKEN</code> env or ask the admin for a provisioned user token.
        </p>
      </form>
    </div>
  );
}
