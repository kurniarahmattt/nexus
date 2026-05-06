import { useQuery } from "@tanstack/react-query";
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from "react-router-dom";
import { api, type Me } from "./api.ts";
import Login from "./pages/Login.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import BridgesList from "./pages/BridgesList.tsx";
import BridgeEdit from "./pages/BridgeEdit.tsx";
import BridgeNew from "./pages/BridgeNew.tsx";
import ChannelsList from "./pages/ChannelsList.tsx";
import ChannelNew from "./pages/ChannelNew.tsx";
import ChannelDetail from "./pages/ChannelDetail.tsx";
import AdminUsers from "./pages/AdminUsers.tsx";
import AdminMcpServers from "./pages/AdminMcpServers.tsx";
import Profile from "./pages/Profile.tsx";

function useMe() {
  return useQuery<{ user: Me | null }>({
    queryKey: ["me"],
    queryFn: () => api.get("/auth/me"),
  });
}

function Topbar({ me }: { me: Me }) {
  const navigate = useNavigate();
  const path = useLocation().pathname;
  const link = (to: string, label: string, adminOnly = false) => {
    if (adminOnly && me.role !== "admin") return null;
    const active = path === to || path.startsWith(to + "/");
    return (
      <Link
        to={to}
        className={`px-3 py-1.5 text-sm rounded-md ${
          active ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-200"
        }`}
      >
        {label}
      </Link>
    );
  };
  return (
    <header className="border-b bg-white">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="font-bold text-slate-900">
            N.E.X.U.S
          </Link>
          <nav className="flex gap-1">
            {link("/", "Dashboard")}
            {link("/bridges", "My Bridges")}
            {link("/channels", "Channels")}
            {link("/admin/users", "Users", true)}
            {link("/admin/mcp-servers", "MCP", true)}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link
            to="/profile"
            className="text-slate-600 hover:text-slate-900"
            title="Edit profile"
          >
            {me.display_name ?? me.username}
            {me.role === "admin" ? " · admin" : ""}
          </Link>
          <button
            onClick={async () => {
              await api.post("/auth/logout", {});
              navigate("/login");
              window.location.reload();
            }}
            className="text-slate-500 hover:text-red-600"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}

export default function App() {
  const { data, isLoading } = useMe();
  if (isLoading) return <div className="p-8 text-slate-500">loading…</div>;
  const me = data?.user;
  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }
  return (
    <div className="min-h-screen">
      <Topbar me={me} />
      <main className="max-w-6xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard me={me} />} />
          <Route path="/bridges" element={<BridgesList />} />
          <Route path="/bridges/new" element={<BridgeNew />} />
          <Route path="/bridges/:slug" element={<BridgeEdit />} />
          <Route path="/channels" element={<ChannelsList />} />
          <Route path="/channels/new" element={<ChannelNew />} />
          <Route path="/channels/:rid" element={<ChannelDetail />} />
          <Route path="/profile" element={<Profile me={me} />} />
          <Route
            path="/admin/users"
            element={me.role === "admin" ? <AdminUsers /> : <Navigate to="/" replace />}
          />
          <Route
            path="/admin/mcp-servers"
            element={me.role === "admin" ? <AdminMcpServers /> : <Navigate to="/" replace />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
