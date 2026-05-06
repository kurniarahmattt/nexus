# Port allocation

Ports are chosen to avoid common conflicts (a local Postgres on `5432`,
a local Redis on `6379`, etc.). The container internals stay default;
host-facing ports use `5433` and `6380`.

| Service             | Host port  | Container port | Where it runs            |
|---------------------|-----------:|---------------:|--------------------------|
| Rocket.Chat         | **3000**   | 3000           | Docker                   |
| MongoDB             | **27017**  | 27017          | Docker (RC backing)      |
| Postgres + pgvector | **5433**   | 5432           | Docker                   |
| Redis               | **6380**   | 6379           | Docker                   |
| mem0-api            | **4100**   | 4100           | Docker (Python sidecar)  |
| nexus-gateway       | **4000**   | —              | Bun on host              |
| nexus-composer      | **4001**   | —              | Bun on host              |
| nexus-runtime       | **4002**   | —              | Bun on host              |

## Host ↔ container bridging

Host services reach containers via `localhost:<port>` (every container
port is exposed). Containers do **not** reach back to host services in
v1 — traffic is one-way (host consumes container).

The exception: Rocket.Chat's outgoing webhook needs to reach the
gateway. The compose file resolves this with
`extra_hosts: ["host.docker.internal:host-gateway"]`, then RC posts to
`http://host.docker.internal:4000/webhook`.

## Dev port (Web UI)

| Port | Purpose                                                   |
|-----:|-----------------------------------------------------------|
| 5173 | `make web-dev` — Vite dev server with HMR for the admin UI|
| 5174 | `make docs-dev` — VitePress dev server for these docs     |

## Production overrides

For non-LAN deployments, bind Postgres and Redis to localhost only:

```yaml
postgres:
  ports: ["127.0.0.1:5433:5432"]

redis:
  ports: ["127.0.0.1:6380:6379"]
```

Or remove the host port mapping entirely if the gateway, composer, and
runtime move into the same compose network. See
[Production caveats](/guide/production-caveats).
