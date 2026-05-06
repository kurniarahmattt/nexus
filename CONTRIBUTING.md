# Contributing to Nexus

Thanks for your interest. Nexus is a personal project that's open to
contributions — bug reports, doc improvements, and code patches are all
welcome.

## Quick start for contributors

1. Fork the repo and clone your fork.
2. Follow the README **Quick Start** to get the stack running locally.
3. Create a branch off `main`: `git checkout -b feature/short-name` or
   `git checkout -b fix/short-name`.
4. Make your changes. Keep commits focused and use clear, present-tense
   messages.
5. Push to your fork and open a pull request against `main`.

## What kinds of contributions are welcome

| Type                          | Notes                                              |
|-------------------------------|----------------------------------------------------|
| Bug reports                   | Use GitHub Issues. Include repro steps + version.  |
| Documentation fixes / clarity | Especially welcome — this is a young project.      |
| New CLI adapters              | See `services/runtime/src/adapters/` for pattern.  |
| New MCP server seeds          | Add to `db/migrations/` as a new file (idempotent).|
| Web UI improvements           | `services/web` (Vite + React 19 + Tailwind v4).    |
| Tests                         | The project is currently lean on tests — PRs that  |
|                               | add coverage to gateway/composer/runtime are great.|
| Production hardening          | TLS, auth, rate limiting, observability — all open.|

## What's likely **not** to be merged

- Renaming/restructuring without a clear motivation.
- Stylistic changes that don't improve correctness or readability.
- Adding heavyweight dependencies for marginal gains.
- Features that conflict with the goals stated in
  [PLANNING.md](PLANNING.md) — open an Issue first to discuss.

## Issue / PR conventions

- **Issues**: title says what's wrong; body has repro steps, expected vs
  actual behavior, and your environment (OS, Bun version, Docker version).
- **PRs**: title summarizes the change in present tense (e.g.
  "fix gateway crash on empty mention"). Body explains the *why*.
- Reference related issues with `Fixes #123` / `Refs #456`.
- One concern per PR. Drive-by refactors in unrelated areas slow review;
  keep them in separate PRs.

## Local development tips

- `make services-up` runs gateway/composer/runtime under `bun --watch`
  in a tmux session named `nexus`. Edit and save — Bun reloads.
- `make services-status` for a quick health probe.
- `make logs` tails the docker stack; `make logs-rocketchat` and
  `make logs-mem0` are scoped variants.
- Database changes: add a new file under `db/migrations/` rather than
  editing existing ones (so migrations stay idempotent on fresh installs).

## Code style

- TypeScript: 2-space indent, double quotes, ES modules.
- SQL: snake_case columns, idempotent migrations (`ON CONFLICT DO NOTHING`
  or `... DO UPDATE` where appropriate).
- Shell scripts: `set -euo pipefail` at the top, `#!/usr/bin/env bash`
  shebang.
- Comments are for *why*, not *what*. Avoid block-quoted JSDoc that just
  restates the function name.

## Licensing

By contributing, you agree that your contributions will be licensed under
the project's [MIT License](LICENSE).

## Code of Conduct

Participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md). Please read it before opening an
issue or PR.

## Questions

Open a GitHub Discussion (or Issue if Discussions are disabled) for design
questions. For security issues, see [SECURITY.md](SECURITY.md) — please
do not open public issues for vulnerabilities.
