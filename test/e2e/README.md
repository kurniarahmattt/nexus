# Nexus end-to-end test

A single, hermetic command that proves a fresh clone of this repo can
install and operate without manual intervention. It runs the full
wizard, brings up the docker stack, starts the host services, issues a
real invite, walks the join handshake, and asserts replay protection
— all inside one Docker-in-Docker container so it cannot affect any
other Docker workload on your host.

## Run it

```bash
make e2e
```

That's the whole thing. First run takes ~10–15 min (mostly the
mem0-api image build pulling CPU-only PyTorch). Re-runs are faster
because Docker caches the harness image layers; pass `--rebuild` (or
`make e2e-rebuild`) when you change the harness itself.

## What gets verified

The script in [run-inside.sh](run-inside.sh) executes eleven ordered
phases and exits non-zero on the first failure:

| # | Phase                                  | Asserts                                                       |
|---|----------------------------------------|---------------------------------------------------------------|
| 0 | Copy working tree                      | Picks up *uncommitted* edits too (it does **not** git-reset). |
| 1 | `scripts/onboard.sh` unattended        | Wizard exits 0 without any TTY.                               |
| 2 | `.env` sanity                          | Every required key is set to a non-default value.             |
| 3 | `make health`                          | Rocket.Chat, Postgres, Redis, Mongo, Mem0 all healthy.        |
| 4 | Host services                          | Gateway `/health` responds; **zero** default agents in DB.    |
| 5 | `make issue-invite`                    | Issues an operator invite for one user/CLI/channel.           |
| 6 | `GET /invite/<code>`                   | HTML + JSON preview return without consuming.                 |
| 7 | `POST /invite/<code>`                  | Creates bridge bot with expected slug, auto-joins channel.    |
| 8 | `POST /join/<code>`                    | Returns slug, server URL, bridge token, and config blob.      |
| 9 | Replay protection                      | Both consumed URLs return `410 Gone` on the second hit.       |
| 10| Bundle endpoint                        | `GET /admin/download/nexus-bridge.js` returns a real bundle.  |
| 11| Real bridge spawn                      | Spawns the bundle with token+server, asserts WS handshake completes, gateway lists the bridge as connected, and removes it after the bridge process exits. |

If any step fails the harness dumps the relevant tmux pane and curl
diagnostics before exiting non-zero.

## Why DinD

`docker:27-dind` is used as the base image so the wizard's
`docker compose up` boots Rocket.Chat / Postgres / Redis / Mongo /
mem0-api **inside** the test container. With `--tmpfs /var/lib/docker`
the inner Docker state lives entirely in memory and is discarded when
the container exits — no leftover containers, volumes, or networks on
the host.

The harness must run as `--privileged` (required by DinD) and on a
host kernel that supports nested cgroups; this is fine on every recent
Linux distro and on Docker Desktop.

## Files

- [Dockerfile](Dockerfile) — DinD base + Bun + GNU coreutils for the
  wizard. Pre-installs everything the wizard needs so the first
  expensive operation inside the run is the mem0-api image build.
- [run.sh](run.sh) — host-side launcher; mounts the repo read-only at
  `/src`, passes the assertion script as `/e2e/run-inside.sh`.
- [run-inside.sh](run-inside.sh) — the actual test, executed inside
  the container after `dockerd` is up.

## CI

The same `make e2e` is what CI should run. The harness exits 0 on
success and non-zero on the first failed assertion, with a clear
heading per phase so failures are easy to spot in logs.
