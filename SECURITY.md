# Security Policy · Polpo Brain (super-agent fork)

This document describes the security posture of the `polpo-fork` branch of
`FedericoCasarella/super-agent`, the threat model assumed, and how to report
vulnerabilities. It is meant for forkers, contributors, and Brain Training
students deploying the stack on their own infrastructure.

For the upstream repo's policy, defer to `FedericoCasarella/super-agent`.

## Reporting a vulnerability

If you discover a security issue:

1. **Do not open a public GitHub issue.**
2. Email **mattia.calastri@gmail.com** with subject `[SECURITY] super-agent — <short title>`.
3. Include: affected file/route, reproduction steps, attack scenario, and your
   contact info for disclosure coordination.
4. Expect an initial reply within 72 hours. Coordinated disclosure window is
   30 days unless mutually extended.

For non-security bugs use normal GitHub issues on the upstream repo.

## Threat model

This stack is designed to be safe under these assumptions:

- **Trust boundary**: the user owns the host machine, the Postgres DB, and
  the Telegram bot token they configured. Inside that boundary, an attacker
  is assumed to be a remote network entity.
- **Deployment target**: single-tenant (one user) on local Postgres, OR
  multi-tenant where every tenant is *cooperative* (no actively malicious
  registered users). The app is NOT yet hardened against fully untrusted
  multi-tenant public deployment.
- **Out of scope**: physical access to the host, OS-level RCE, Postgres
  privilege escalation, supply chain on `npm install`.

## Hardening status (sess.2818)

Detailed posture is documented in [`POLPO_FORK_README.md`](./POLPO_FORK_README.md#-robustness--security-audit). Summary:

| Class | Status |
|---|---|
| 🔴 Critical (3 of 3) | ✅ closed |
| 🟡 High (3 of 4) | ✅ closed; 1 deferred (architecture, not exposure) |
| 🟢 Medium (3) | tracked, see [TODO](./POLPO_FORK_README.md#-todo-refresh-sess2818) |

**Maturity**: ~8/10 — multi-user trusted ready, not multi-user public ready.

## Deployment hardening checklist

Before exposing this stack to anyone besides yourself, complete:

- [ ] **JWT_SECRET** — generated with `openssl rand -base64 32` and injected
      via environment, not committed. Startup fails fast if missing or `<32`
      chars (sess.2818 C1).
- [ ] **NODE_ENV=production** — gates cookie `Secure` flag and disables
      verbose logging.
- [ ] **HTTPS** — terminate TLS at a reverse proxy (Caddy / nginx / Cloudflare
      Tunnel). Cookies have `Secure` only in production, so plain HTTP is a
      hard regression.
- [ ] **Postgres credentials** — strong password, network-bound to loopback
      or VPC, never `postgres:postgres@public-host`.
- [ ] **Bot token rotation** — Telegram bot tokens used for chatId binding.
      Rotate via BotFather if you suspect a leak; in the meantime use
      `POST /api/telegram/unlink` (web UI: Settings → Telegram → Unlink chat)
      to drop the compromised binding.
- [ ] **Backups** — Postgres dumps include encrypted credentials (IMAP
      passwords, GHL keys, etc.). Treat backups as secret material.
- [ ] **Reverse-proxy IP allowlist** — if exposed to a small known audience
      (e.g. Brain Training students), consider IP-based gating at the proxy
      layer as defense-in-depth.
- [ ] **Audit logs** — Postgres `messages` and `agent_runs` tables already
      log activity. Forward to your SIEM if you have one.

## Known limitations (not yet fixed)

These are documented and tracked, not silently accepted:

1. **MCP bridge auth chain (H2)** — `backend/src/mcp/config.ts` does not
   inject auth into the spawned subprocess env, so the bridge currently
   cannot reach `/api/tools` (silent 401 → empty tools list). This is a
   functionality gap; the security surface is closed by `requireUser`.
   Architecture overhaul pending coordination with the upstream maintainer.

2. **JWT revocation (M2)** — JWT `expiresIn: '30d'` with no server-side
   blacklist. Logout clears the cookie client-side only. A stolen token
   remains valid for up to 30 days. Acceptable for single-user; rotate the
   `JWT_SECRET` to mass-invalidate if compromised.

3. **Telegram first-contact race (H3)** — closed at the protocol level
   (one-time code) but per-IP rate limit at the proxy layer is recommended
   for public exposures, in addition to the in-process per-(user, chat)
   rate limit already shipped.

4. **`uuid` transitive vulns via `node-cron`** — `npm audit` flags 2
   moderate vulnerabilities in the `uuid` package transitively required by
   `node-cron`. `npm audit fix --force` upgrades `node-cron` 3→4 which is
   a breaking change on the scheduler surface. Tracked, not in scope for
   the current hardening pass.

## What this stack does NOT protect against

- A malicious user with valid credentials (no privilege separation inside
  a tenant; everything they store is exposed to anyone who knows their
  password).
- A compromised `JWT_SECRET` (rotate it and invalidate all sessions).
- A compromised Postgres host (everything is decryptable from the DB).
- A compromised Telegram bot token (use the `/api/telegram/unlink`
  emergency endpoint, then rotate via BotFather).
- Network-level attacks (TLS hijack on misconfigured proxies, DNS
  poisoning). Handle at the deployment layer.

## Security-sensitive code conventions

When contributing changes that touch the security surface, follow:

- **Crypto-grade randomness**: use `crypto.randomInt` / `crypto.randomBytes`
  from `node:crypto`, never `Math.random()` (sess.2818 H3+ post-review).
- **Authoritative user identity**: derive `user_id` from `req.user.id`
  (cookie auth context), never from `req.body` or `req.query`.
- **Rate-limit auth endpoints**: any new endpoint accepting credentials
  or generating tokens needs `express-rate-limit` applied.
- **Fail-fast on missing config**: required secrets must throw at startup,
  not silently fall back to a default.

## Sister branches

- `polpo-fork` — operational identity branch (where Mattia runs day-to-day)
- `polpo-overlay` — older scaffold branch (connectors + identity seed)
- `contrib/security-hardening` — upstream-friendly version of the
  security fixes, ready for PR to `FedericoCasarella/super-agent` main
- `contrib/reliability-fixes` — DB migration ordering fix candidate
- `main` — mirror of upstream, never modified locally

## Acknowledgments

Hardening pass sess.2818 (May 28, 2026) audited by:
- `feature-dev:code-reviewer` agent (Claude Code) — initial vulnerability sweep
- `security-guidance@claude-code-plugins` plugin — background security review
  feedback loop (caught Math.random → CSPRNG and workflow injection patterns)
