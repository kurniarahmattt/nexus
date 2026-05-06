import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type Bridge, type Channel, type Me } from "../api.ts";

export default function Dashboard({ me }: { me: Me }) {
  const bridges = useQuery<{ bridges: Bridge[] }>({
    queryKey: ["bridges"],
    queryFn: () => api.get("/me/bridges"),
  });
  const channels = useQuery<{ channels: Channel[] }>({
    queryKey: ["channels"],
    queryFn: () => api.get("/channels"),
  });

  return (
    <div className="space-y-8">
      <section>
        <h2 className="text-xl font-semibold mb-1">
          Welcome, {me.display_name ?? me.username}
        </h2>
        <p className="text-sm text-slate-600">
          {me.role === "admin"
            ? "Admin view — create users, see all bridges and channels."
            : "Create sessions (bridges) for your local AI CLI, invite teammates to channels."}
        </p>
      </section>

      <section className="grid md:grid-cols-2 gap-6">
        <Card
          title="Bridges"
          sub={`${bridges.data?.bridges.length ?? 0} session(s)`}
          cta={{ to: "/bridges/new", label: "+ New bridge" }}
        >
          <ul className="text-sm divide-y">
            {(bridges.data?.bridges ?? []).slice(0, 5).map((b) => (
              <li key={b.slug} className="py-2 flex justify-between">
                <Link to={`/bridges/${b.slug}`} className="text-slate-800 hover:underline">
                  @{b.slug}
                </Link>
                <span
                  className={`text-xs ${
                    b.is_connected ? "text-emerald-600" : "text-slate-400"
                  }`}
                >
                  {b.is_connected ? "online" : "offline"}
                </span>
              </li>
            ))}
            {bridges.data?.bridges.length === 0 && (
              <li className="py-3 text-slate-400 text-sm">No bridges yet.</li>
            )}
          </ul>
        </Card>

        <Card
          title="Channels"
          sub={`${channels.data?.channels.length ?? 0} channel(s)`}
          cta={{ to: "/channels/new", label: "+ New channel" }}
        >
          <ul className="text-sm divide-y">
            {(channels.data?.channels ?? []).slice(0, 5).map((ch) => (
              <li key={ch.id} className="py-2 flex justify-between">
                <Link
                  to={`/channels/${ch.rocketchat_rid}`}
                  className="text-slate-800 hover:underline"
                >
                  #{ch.name}
                </Link>
                <span className="text-xs text-slate-400">{ch.kind}</span>
              </li>
            ))}
            {channels.data?.channels.length === 0 && (
              <li className="py-3 text-slate-400 text-sm">No channels yet.</li>
            )}
          </ul>
        </Card>
      </section>
    </div>
  );
}

function Card({
  title,
  sub,
  cta,
  children,
}: {
  title: string;
  sub?: string;
  cta?: { to: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex justify-between items-baseline mb-3">
        <div>
          <h3 className="font-semibold text-slate-900">{title}</h3>
          {sub && <p className="text-xs text-slate-500">{sub}</p>}
        </div>
        {cta && (
          <Link to={cta.to} className="text-sm text-sky-600 hover:underline">
            {cta.label}
          </Link>
        )}
      </div>
      {children}
    </div>
  );
}
