# 🐙 Polpo Brain — project CLAUDE.md

Second Brain operativo su Telegram, runtime di **AI Coach Italia**. Fork brandizzato di
`super-agent` di Federico Casarella, co-sviluppato con full push access.

## Identità & relazione repo (CRITICO)
- **`polpo-fork`** = ramo CANONICALE Polpo (identità + sicurezza + Sovereign Mode). È ciò che gira in locale. NON sovrascrivere il design di Federico.
- **`origin/main`** = baseline Federico (feature: multi-vault, MRI viz, P2P brain, sub-agent stats, i18n). Sviluppa veloce.
- **`contrib/*`** = fix puri upstream-friendly per PR a Federico (naming originale, no branding). Pattern sess.2818.
- **`integration/*`** = branch effimeri per mergiare `origin/main` → `polpo-fork` in isolamento, poi FF su polpo-fork solo a verde.
- ⚠️ **Cicatrice sess.2817**: cherry-pick fallisce su brand-driven divergence (rebrand tocca i file core). Usa SEMPRE branch integration, mai cherry-pick auto.

## Stack
- **Backend**: Node 25 + TS · Express · ws · Telegraf · Postgres (`polpo_brain` su :5432) · node-cron · `tsx watch src/index.ts`
- **Frontend**: Vite + React + TS + Tailwind · force-graph-3d · three.js · `:5173`, proxy `/api` → `127.0.0.1:8787`
- **LLM**: Claude Code CLI (`claude -p` headless) + MCP

## Run
```bash
npm install && npm run db:migrate && npm run dev   # frontend :5173 + backend :8787
```
Già in esecuzione come LaunchAgent → log `~/Library/Logs/polpo-brain-backend.{out,err}.log`.

## Auth — Sovereign Mode (sess.2839)
Single-user per istanza (no SaaS, `/register` rimosso). Owner creato 1-shot via `/api/auth/initialize`.
Su macchina owner (loopback + `POLPO_SOVEREIGN=1` + same-origin) → auto-login, nessun muro. `/me` ritorna owner senza token.
Owner DB: `mattia@polpo.brain` (id 1).

## Doctrine Polpo
- **Sicurezza è il nostro layer** (C1-C3, H1-H4, TOCTOU, JWT revocation, CSPRNG via `crypto.randomInt`). Mai `Math.random` per token.
- **Mai leggere `.env` nudo** (deny rule attiva) — usa endpoint `/api/auth/bootstrap` per stato auth, o `grep VAR | cut`.
- Branding consistente: palette Astra + 🐙 Bot Family avatar (no emoji inline come logo).
- Edit chirurgico retrocompatibile > refactor.

## Ports vivi
`:5173` frontend · `:8787` backend API/ws · `:5432` postgres
