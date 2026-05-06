# Contributing to Nexus

Nexus is a personal project that's open to contributions — bug reports,
doc improvements, and code patches are all welcome.

> The canonical contribution guide lives at
> [`CONTRIBUTING.md`](https://github.com/kurniarahmattt/nexus/blob/main/CONTRIBUTING.md)
> in the repo root. This page mirrors the highlights for the docs site.

## Quick start for contributors

1. Fork the repo and clone your fork.
2. Follow the [Quick start](/guide/quick-start) to get the stack running
   locally.
3. Branch off `main`: `git checkout -b feature/short-name` or
   `fix/short-name`.
4. Make focused commits with clear, present-tense messages.
5. Push to your fork and open a PR against `main`.

## Welcome contributions

| Type                          | Notes                                              |
|-------------------------------|----------------------------------------------------|
| Bug reports                   | Use GitHub Issues. Include repro steps + version.  |
| Documentation fixes / clarity | Especially welcome — this is a young project.      |
| New CLI adapters              | See [Adding a CLI adapter](/reference/adapters).   |
| New MCP server seeds          | Add to `db/migrations/` as a new file (idempotent).|
| Web UI improvements           | `services/web` (Vite + React 19 + Tailwind v4).    |
| Tests                         | Lean coverage right now; PRs that add gateway / composer / runtime coverage are great. |
| Production hardening          | TLS, auth, rate limiting, observability — all open.|

## Likely **not** to be merged

- Renaming/restructuring without a clear motivation.
- Stylistic changes that don't improve correctness or readability.
- Adding heavyweight dependencies for marginal gains.
- Features that conflict with the goals stated in
  [PLANNING.md](https://github.com/kurniarahmattt/nexus/blob/main/PLANNING.md)
  — open an Issue first to discuss.

## House rules

- **English only** in tracked content. Issues, PRs, code, comments,
  commit messages — all English. (Conversations on Discussions can be
  whatever language; tracked content cannot.)
- **One concern per PR.** Drive-by refactors slow review; keep them
  separate.
- **New migrations, not edited ones.** SQL migration files are
  append-only. Editing an applied migration breaks idempotency.
- **No comments on the *what*.** Code comments should explain *why*, not
  paraphrase the code itself.
- **No secrets in commits.** `.env` is gitignored; keep it that way.
  Don't commit `.env.local`, fixture files with real keys, or screenshot
  outputs that include tokens.

## Local development tips

- `make services-up` runs gateway/composer/runtime under `bun --watch`
  in a tmux session named `nexus`. Edit a file, hit save, Bun reloads.
- `make services-status` for a quick health probe of the host services.
- `make logs` tails the docker stack; `make logs-rocketchat` and
  `make logs-mem0` are scoped variants.
- For DB changes, add a new file under `db/migrations/` rather than
  editing existing ones (so migrations stay idempotent on fresh
  installs).
- For docs changes, `make docs-dev` runs the VitePress dev server on
  port 5174 with HMR.

## Code style

- TypeScript: 2-space indent, double quotes, ES modules.
- SQL: snake_case columns, idempotent migrations
  (`ON CONFLICT DO NOTHING` or `... DO UPDATE` where appropriate).
- Shell scripts: `set -euo pipefail` at the top, `#!/usr/bin/env bash`
  shebang.
- Comments are for *why*, not *what*. Avoid block-quoted JSDoc that
  just restates the function name.

## Licensing

By contributing, you agree your contributions will be licensed under
the project's [MIT License](https://github.com/kurniarahmattt/nexus/blob/main/LICENSE).

## Code of Conduct

Participation is governed by the
[Code of Conduct](/contributing/code-of-conduct). Please read it before
opening an issue or PR.

## Questions

Open a [GitHub Discussion](https://github.com/kurniarahmattt/nexus/discussions)
for design questions or "how do I…" usage. For security issues, see
[Security policy](/contributing/security) — please do not open public
issues for vulnerabilities.
