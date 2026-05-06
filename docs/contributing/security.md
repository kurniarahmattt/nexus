# Security policy

> The canonical security policy lives at
> [`SECURITY.md`](https://github.com/kurniarahmattt/nexus/blob/main/SECURITY.md)
> in the repo root. This page mirrors it for the docs site.

## Reporting a vulnerability

If you find a security vulnerability in Nexus, **please do not open a
public GitHub issue**. Report it privately so the issue can be fixed
before disclosure:

- Open a
  [GitHub Security Advisory](https://github.com/kurniarahmattt/nexus/security/advisories/new)
  on the repository (preferred), or
- Email the maintainer at
  [`kurniarahmatt@gmail.com`](mailto:kurniarahmatt@gmail.com) with
  subject `[nexus-security] <short description>`.

Please include:

- A clear description of the issue and its impact.
- Steps to reproduce, or a minimal proof-of-concept.
- Affected version (commit SHA or release tag).
- Your suggested fix, if you have one.

You should receive an acknowledgement within **5 business days**. If
the issue is confirmed, the maintainer will work on a fix and
coordinate disclosure with you. Reporters who follow this policy will
be credited in the release notes (unless they prefer to remain
anonymous).

## Supported versions

This project is in active development. Only the **`main` branch**
receives security fixes — there are no LTS releases yet.

| Version      | Supported          |
|--------------|--------------------|
| `main`       | ✅                 |
| any older tag| ❌ (please update) |

## Threat model — current state

Nexus is **dev-ready, not production-hardened** (see
[Production caveats](/guide/production-caveats)). Known limitations:

- The repo ships with **dev-only default secrets** in `.env.example` and
  the compose file. These must be replaced with `openssl rand`-generated
  values before any non-LAN deployment.
- The gateway WebSocket endpoint (port `4000`) does not enforce TLS in
  dev. Front it with caddy/nginx for any deployment beyond a trusted
  LAN.
- Bridge tokens are bearer credentials — keep them out of public chats,
  screenshots, and shell history.
- Bot Rocket.Chat passwords are random per-bot since `2026-05-06`. Bots
  created on instances running earlier code should be re-issued via
  `make create-bridge` to rotate credentials.

## Hardening guidance

If you intend to deploy Nexus beyond a trusted LAN, work through
[Production caveats](/guide/production-caveats) before exposing the
host. The short version:

1. Replace every secret in `.env`.
2. Front the gateway with TLS (caddy / nginx).
3. Restrict Postgres / Redis to localhost or a private network.
4. Back up the Postgres volume on a schedule.
5. Rotate bridge tokens when team members leave.

If you spot a hardening gap not covered there, please report it via the
channels above.
