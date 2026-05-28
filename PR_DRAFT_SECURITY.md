# Pull Request Draft — Security Hardening

**Branch**: `contrib/security-hardening` → `main`
**Author**: Mattia Calastri
**Audit by**: code-review (sess.2818, 28 May 2026)
**Net diff**: 3 commits · 8 files · +177 / −58 LOC

## Summary

This PR closes **7 of 7** vulnerabilities surfaced by a confidence-filtered backend audit (HIGH-severity only, ≥80% confidence threshold). All fixes are applied directly on top of `origin/main` (HEAD `34cb541`), so the changes integrate cleanly with the multi-vault / sub-agent stats / P2P brain features you shipped in the last two weeks.

No branding, no rebrand, no Astra/Polpo-specific code. Upstream-compatible.

| Finding | Severity | Status | Commit |
|---|---|---|---|
| JWT_SECRET hardcoded fallback | 🔴 Critical | ✅ closed | `92136d0` |
| Cookie `secure: false` unconditional | 🔴 Critical | ✅ closed | `92136d0` |
| `x-super-agent-user` header IDOR | 🔴 Critical | ✅ closed | `7b7bcb5` |
| No rate limit on `/login`, `/register` | 🟡 High | ✅ closed | `92136d0` |
| Password minimum 6 chars | 🟡 High | ✅ closed | `92136d0` |
| Telegram first-contact binding race | 🟡 High | ✅ closed | `7b7bcb5` |
| Scheduler error swallowed silently | 🟢 Medium | ✅ closed | `775d0a5` |

## Why this matters

`super-agent` stores third-party credentials in the DB (Telegram bot tokens, IMAP passwords, GHL API keys, future ElevenLabs / Fathom keys). The account password is the single gate over the whole bundle. The current hardening posture is sufficient for solo local development, but several patterns block safe multi-user deployment — even on a trusted LAN.

The fixes below treat the project as what it's becoming: an OSS framework that other people will fork, deploy, and trust with real credentials.

---

## Commit 1 — `92136d0` · Auth surface hardening

**Files**: `backend/src/config.ts`, `backend/src/auth/index.ts`, `backend/src/auth/routes.ts`, `backend/package.json`, `package-lock.json`

### Change 1.1 — `config.ts` JWT_SECRET fail-fast

The string `'dev-insecure-change-me'` is in the public repo. Any deployment without env injection silently runs with a known secret and accepts forged JWTs for any uid.

```ts
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error(
    'JWT_SECRET env var is required (>=32 chars). Generate one with: openssl rand -base64 32'
  );
}
```

The startup fails loudly instead of silently exposing the deployment.

### Change 1.2 — `auth/index.ts:70` cookie `secure` flag

`secure: false` was unconditional. On any HTTPS deployment (production behind a reverse proxy, tunnel, etc.), the session cookie travelled in cleartext. On dev HTTP localhost, `secure: true` would prevent cookie set entirely — so the flag has to track environment.

```ts
secure: config.isProduction,  // tracks NODE_ENV
```

### Change 1.3 — Rate-limit `/login` and `/register`

Added `express-rate-limit@8.5.2`. bcrypt(10) caps each attempt at ~100ms — sufficient against a single attacker, insufficient against distributed bruteforce or registration-flood (mass account creation).

- `/login`: 20 attempts / 15min per IP
- `/register`: 5 attempts / 15min per IP
- RFC `draft-7` headers so clients can adapt their retry logic

### Change 1.4 — Password policy 6 → 8 chars (+ max 128)

The account password is the bundle key for all stored secrets. 6 chars is too thin for an app that mediates Telegram/IMAP/GHL credentials. Max 128 to prevent pathological lengths.

---

## Commit 2 — `7b7bcb5` · Tools-endpoint IDOR + Telegram binding race

**Files**: `backend/src/api/routes.ts`, `backend/src/telegram/bot.ts`

### Change 2.1 — `/api/tools/:name` no longer trusts `x-super-agent-user` blindly

Previous flow: if header present, header wins. Cookie consulted only as fallback. Any authenticated user could pass an arbitrary header value and act as another user, executing IMAP/GHL/vault tool calls in their context. Textbook IDOR on the entire tool surface.

New flow:
- If **header present AND cookie present** → they MUST agree, else `403`. Closes cross-user impersonation via header.
- If **header present AND no cookie** → accept only from loopback IP (`127.0.0.1`, `::1`, `::ffff:127.*`). The MCP bridge subprocess runs on loopback by design; a public reverse-proxy must not be able to assert identity by header alone.
- If **cookie only** → use cookie identity (browser path).
- If **neither** → `401`.

The bridge use case (subprocess on `127.0.0.1`, header-only) is preserved.

### Change 2.2 — Telegram `chatId` binding race closed

Previously, the first chat sending `/start` (or any message) won the binding to a leaked bot token. An attacker who leaked or guessed a user's bot token could race the legitimate user, bind their own chat, lock the legit user out of Telegram access, and receive all AI responses + vault content via the bot.

New flow uses an explicit verification code:

1. User generates a 6-char code via authenticated `POST /api/telegram/link-code` (10min TTL, CSPRNG-backed via `crypto.randomInt`).
2. User sends `/link CODE` from the chat they want to bind.
3. Bot validates code + TTL + bot-side rate limit (5 attempts / 15min per `(user, chat)`).
4. Match → bind. Mismatch / expired / over rate-limit → reject with reason.

Defense-in-depth: leaked token alone is insufficient. Attacker also needs a valid web session to mint a code.

Emergency `POST /api/telegram/unlink` endpoint added for compromised bindings.

Existing bindings (`cur.chatId` already set) are unaffected — the new code path only triggers when binding is null.

Code uses a 32-symbol alphabet (`O`/`0`/`I`/`1` omitted for readability) — ~1.07B combinations across 10min × 5 attempts = mathematically unviable bruteforce.

---

## Commit 3 — `775d0a5` · Scheduler error visibility

**Files**: `backend/src/scheduler/index.ts`

The inner try/catch in `runTick`'s `finally` block previously swallowed all errors silently. The visible symptom is subtle: when a connector tick completes but the `lastTickAt` persistence fails (DB hiccup, JSON marshalling, migration race), `catchUpOnBoot` re-fires the same tick on next startup because the state row hasn't advanced.

Now: log with the `[scheduler:u<id>:<name>]` prefix used elsewhere, so it's grep-able in operator logs. No behavior change for the happy path.

---

## Testing

- `tsc -p backend/tsconfig.json` passes on every commit
- Manual smoke test possible (see `scripts/smoke.sh` on `polpo-fork` branch)
- No DB migration changes — schema is identical to `34cb541`
- No new runtime dependencies except `express-rate-limit@8.5.2`

## What's NOT in this PR

Deliberately scoped out:
- **MCP bridge auth chain** — `mcp/config.ts` doesn't inject auth into the subprocess env, so the bridge currently can't reach `/api/tools` (silent 401 → empty tools list). This is a functionality gap, not a security exposure; needs an architecture call (per-user spawn vs service token vs in-process tools) and is too invasive for a security PR.
- **JWT revocation** — JWT `expiresIn: '30d'` with no server-side blacklist means logout is client-side only. Acceptable for single-user; a real concern for shared deployments. Worth its own discussion.
- **`uuid` moderate vulns via `node-cron`** — `npm audit fix --force` would upgrade `node-cron@3.x → 4.x` (breaking change on the scheduler API surface). Needs coordination, not in scope here.

## Local validation steps

```bash
git checkout contrib/security-hardening
npm install
JWT_SECRET="$(openssl rand -base64 32)" npm run build
# expected: clean tsc output, no errors
```

## Notes for review

- All `// comment` blocks explain the why, not the what. Feel free to strip or reword for your style.
- Commit messages use the format common in your repo (`feat:` / `fix:` etc.) but I can squash if you prefer a single commit.
- Happy to split into 3 separate PRs (one per commit) if that maps better to your review workflow.
