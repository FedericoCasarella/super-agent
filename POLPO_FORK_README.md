# 🐙 Polpo Brain — Fork Operating Manual

> **Branch `polpo-fork`** — rebrand identitario + bug fix sopra `super-agent` upstream (Federico Casarella).
> Forked sess.2282 (26 mag 2026) — `lo facciamo nostro, aggiorna il branding`.

## Cosa è questo branch

Fork attivo del repo `super-agent` di Federico, rebrandato come **Polpo Brain** — l'identità AI sovrana di Mattia. Mantiene **upstream-safe doctrine**: i commit qui sono additivi/sostitutivi su layer rebrand, mai distruttivi sulla logica core di Federico. `git pull origin main` resta possibile (con merge conflict gestibili sui file rebrandati).

## Stack invariato (da Federico)

- Backend: Node + TS, Express, ws, Telegraf, Postgres, node-cron
- Frontend: Vite + React + TS + Tailwind
- LLM: Claude Code CLI (`claude -p` headless)
- Brain: Obsidian-style markdown vault + Postgres index
- MCP bridge: stdio → HTTP `/api/tools`

## Quick start (Polpo edition)

```bash
# Prerequisito: Postgres.app installato (https://postgresapp.com/)
export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"
createdb polpo_brain

# Clone + checkout
git clone https://github.com/FedericoCasarella/super-agent.git
cd super-agent
git checkout polpo-fork

# Install
npm install

# Migrate (NB: bug ordering scheduled_tasks già fixato in commit d195a2c)
DATABASE_URL='postgresql://mattiacalastri@localhost:5432/polpo_brain' npm run db:migrate

# Run (env vars inline — .env hook locked by design)
DATABASE_URL='postgresql://mattiacalastri@localhost:5432/polpo_brain' \
JWT_SECRET='polpo-dev-local-only-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' \
npm run dev
```

Open `http://localhost:5173` → onboarding wizard rebranded Polpo Brain.

## Identifier rinominati (semantic layer)

| Federico (`super-agent`) | Polpo (`polpo-fork`) |
|---|---|
| `super-agent` (npm) | `polpo-brain` |
| `super_agent` (DB default) | `polpo_brain` |
| `super_agent` (MCP server name) | `polpo_brain` |
| `super_agent_session` (cookie) | `polpo_brain_session` |
| `SUPER_AGENT_API` (env) | `POLPO_BRAIN_API` |
| `SUPER_AGENT_USER_ID` (env) | `POLPO_BRAIN_USER_ID` |
| `x-super-agent-user` (header) | `x-polpo-brain-user` |
| `mcp__super_agent__*` (tool ns) | `mcp__polpo_brain__*` |

Tool names che usi nel Claude system prompt diventano `mcp__polpo_brain__roadmap_get`, etc.

## Palette visiva (Astra canonical)

- `bg`: `#0a0f1a` (blu-nero Astra, era `#0a0a0c`)
- `accent`: `#00d4aa` (teal canonical, era purple `#c084fc`)
- `accent2`: `#ff6b9d` (Polpo pink, era cyan `#22d3ee`)
- Body gradients: teal+pink radial
- Logo: `🐙` emoji inline + gradient (no asset PNG dipendenza)
- Header copy: "Polpo Brain · sovereign mind"

## Persona AI (system prompt)

System prompt opening: `Your name is Polpo — the user's sovereign AI brain (🐙). You are their personal AI advisor — internalize Hormozi, Robbins, Naval, Jim Rohn, Dan Koe, Brunson, Drucker.`

Federico's mentor library + advisor stance intatti. Solo identità + nome ancorati pre-mentor.

## Commit history `polpo-fork`

```
4c88b91 feat(brand): persona identity 'Your name is Polpo'
c50b895 feat(brand): semantic layer super_agent → polpo_brain (10 files)
43d4748 feat(brand): visual rebrand Astra palette + 🐙 logo (7 files)
d195a2c fix(db): create scheduled_tasks before ALTER+INDEX reference
8d4f32e first commit (Federico baseline)
```

## ⛔ Vincoli operativi attivi

1. **NO push** su `origin` (= `FedericoCasarella/super-agent.git`) fino ad accordo bilaterale Federico-Mattia formalizzato (Term Sheet v1.1 + validation Storari pending)
2. **EMBARGO totale** sul brand "Polpo Brain" verso Federico fino a accordo formale (Trickster sess.2282 raccomandazione + Tony cliente presente in call commerciale mer 27)
3. Per push pubblico: aggiungere remote `polpo` puntato a `mattiacalastri/super-agent-polpo` (da forgiare post-gate) → `git push polpo polpo-fork`

## Branch siblings nello stesso clone

- `main` — Federico baseline pristine, sync con origin
- `polpo-overlay` — 5 commit scaffold sess.2261 (connettori fathom/ghl/elevenlabs + identity seed + docs design, additivi su file nuovi, ZERO file Federico toccati)
- `polpo-fork` — questo branch (4 commit rebrand attivo)

## Smoke test status (verificato sess.2282)

✅ Backend Express `:8787` health 200
✅ Frontend Vite `:5173` HTTP 200, proxy `/api`→backend
✅ DB `polpo_brain` migrato, 10 tabelle
✅ Register `POST /api/auth/register` → user creato
✅ Login `POST /api/auth/login` → JWT `polpo_brain_session` cookie set HttpOnly+SameSite=Lax
✅ Authenticated `GET /api/status` → response coerente
⚠️ TS `Server` deprecated in `mcp/bridge.ts` (refactor McpServer pending, NON blocker)
⚠️ Connettori scaffold fathom/ghl/elevenlabs (sess.2261, in branch `polpo-overlay`) NON merged in polpo-fork — decisione strategica pending Mattia

## TODO future (per sessione awake)

- [ ] Merge `polpo-overlay` 5 commit scaffold dentro `polpo-fork` (decisione Mattia + scope: vogliamo i connettori AS-IS o vogliamo rebrand anche quelli?)
- [ ] Refactor `Server` → `McpServer` in `backend/src/mcp/bridge.ts` (non-triviale, API diversa)
- [ ] Decisione architetturale: Polpo Brain TypeScript (`polpo-fork`) vs Polpo Brain FastAPI (`~/projects/polpo-brain/`) → quale è IL prodotto?
- [ ] Setup remote `polpo` post-accordo Federico
- [ ] Decisione layer connettori "veri" (Fathom API + GHL MCP + ElevenLabs voice) per portare scaffold sess.2261 a runtime funzionante

---

**Generated sess.2282 (26 mag 2026 01:15 CEST) by Polpo in autonomous overnight mode.**
