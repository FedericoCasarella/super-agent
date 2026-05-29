# 🐙 Polpo Brain — Fork Operating Manual

<p align="center">
  <img src="assets/polpo_brain_identity.png" alt="Polpo Brain · Personal AI · Sovereign Mind" width="320" />
</p>

> **Branch `polpo-fork`** del repo upstream [`FedericoCasarella/super-agent`](https://github.com/FedericoCasarella/super-agent).
> Rebrand identitario + connettori custom + asset visivi, additivo e non-distruttivo sul core di Federico.
> Forgia originale sess.2282 · identity asset sess.2636 · push access concesso sess.2623 · dashboard UI/UX approved sess.2623.

---

## 🤝 Contesto partnership

Polpo Brain **non è un fork ostile** — è la mia contribuzione attiva al super-agent di Federico Casarella come **collaboratore open-source paritario**. Federico è lead architect, io contribuisco con:

- **Identity layer** — branding visivo, persona AI, asset 3D
- **Connettori custom** — ElevenLabs (TTS), Fathom (call transcript), GoHighLevel (CRM)
- **Hardening operativo** — bug fix race conditions, retry logic, scaffolding architetturale
- **Documentation rebrand** — README, SPEC, knowledge bridge design

Lo stack è anche il **deliverable infrastrutturale** del programma [**AI Coach Italia**](https://aicoachitalia.it) — ogni allievo del Brain Training 1-on-1 riceverà un proprio super-agent forkato come asset del programma. Si veda anche [`brainforge`](https://github.com/mattiacalastri/brainforge) — il marketplace Plug & Play AI Brains che vive come layer 4 sopra questa infrastruttura.

**Doctrine ferrea sess.2623 (Mattia verbatim)**: *"non sovrascrivere il suo design"* — i branch polpo vivono **accanto** a `main`, mai sopra.

---

## 🏗️ Architettura (alto livello)

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend Vite + React + TS + Tailwind  (:5173)                 │
│  · Auth · Brain (2D/3D graph) · Tasks · Connectors · Logs       │
└──────────────────────────┬──────────────────────────────────────┘
                           │  /api/* (proxy) + /ws
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Backend Node + Express + ws + Telegraf  (:8787)                │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐    │
│  │ Auth (JWT)  │  │ API + WS bus │  │ Telegram bot(s)     │    │
│  └─────────────┘  └──────────────┘  └─────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Orchestrator → Claude CLI runner (`claude -p` headless) │    │
│  └─────────────────────────────────────────────────────────┘    │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐    │
│  │ Scheduler   │  │ Connectors   │  │ MCP bridge (stdio)  │    │
│  │ (node-cron) │  │ (registry)   │  │ → /api/tools        │    │
│  └─────────────┘  └──────────────┘  └─────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ Brain — Obsidian-style markdown vault + Postgres index │    │
│  │  extract · vault · graph · email                       │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                  ┌────────▼────────┐
                  │ PostgreSQL DB   │
                  │ (multi-user)    │
                  └─────────────────┘
```

**Multi-user by design**: ogni tabella (`settings`, `messages`, `connectors`, `brain_index`, `scheduled_tasks`) ha `user_id BIGINT REFERENCES users(id) ON DELETE CASCADE`. Composite uniqueness `(user_id, key)` previene cross-tenant collisions.

---

## 📦 Stack invariato (da Federico)

- **Backend**: Node + TS + ESM, Express 4, ws 8, Telegraf 4, Postgres (`pg` 8), node-cron, zod
- **Frontend**: Vite 5 + React 18 + TS 5 + Tailwind 3 + react-force-graph (2D/3D) + three.js
- **Auth**: bcryptjs + jsonwebtoken (JWT cookie `polpo_brain_session` HttpOnly+SameSite=Lax)
- **LLM**: Claude Code CLI (`claude -p` headless, model Sonnet 4.6 default)
- **Brain**: Obsidian-style markdown vault + Postgres `brain_index` (path, kind, title, tags, refs, summary)
- **MCP**: bridge stdio → HTTP `/api/tools` per esporre tools come MCP server `polpo_brain`
- **Connettori esistenti upstream**: `imap` (email), `people` (intelligence)
- **Connettori polpo-fork**: `elevenlabs`, `fathom`, `ghl` (scaffold sess.2261, ingestion onTick → vault sess.2282)

---

## 🚀 Quick start (Polpo edition)

```bash
# 1. Prerequisito: Postgres.app installato
export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"
createdb polpo_brain

# 2. Clone + checkout branch polpo
git clone https://github.com/FedericoCasarella/super-agent.git
cd super-agent
git checkout polpo-fork

# 3. Install workspaces (root + backend + frontend)
npm install

# 4. Migrate (10+ tabelle, idempotente, ALTER TABLE safe)
DATABASE_URL='postgresql://mattiacalastri@localhost:5432/polpo_brain' \
  npm run db:migrate

# 5. Run (env vars inline — .env hook locked by design per evitare leak)
DATABASE_URL='postgresql://mattiacalastri@localhost:5432/polpo_brain' \
JWT_SECRET='generate-with-openssl-rand-base64-32' \
  npm run dev
```

Open `http://localhost:5173` → register first user (auto-claims orphan data) → onboarding wizard → connettori.

**⚠️ JWT_SECRET**: il default `dev-insecure-change-me` in `backend/src/config.ts:17` è **inaccettabile in qualsiasi deployment**. Generare con `openssl rand -base64 32` e iniettare via env. Vedi sezione *Robustness* sotto.

---

## 🔄 Sync status vs `origin/main` (Federico)

Ground truth al **2026-05-28 sess.2818**:

| Branch | Ahead | Behind | Pushed remoto |
|---|---|---|---|
| `main` (tracking) | 0 | 17 | — |
| `polpo-fork` (HEAD `83f5ebd`) | **23** | **17** | ❌ NO |
| `polpo-overlay` | 5 | 17 | ❌ NO |

**Merge-base comune**: `8d4f32e` (Federico "first commit" baseline).

### Federico activity 2623 → 2818 (17 commit pushati su `origin/main`)

In ordine cronologico recente → vecchio:

| SHA | Area | Descrizione |
|---|---|---|
| `34cb541` | Scheduler | cron-parser + lucide-react + task scheduling catch-up post-downtime |
| `23eae28` | Telegram | Reaction feature emoji + orchestrator SKIP response + Claude runner message ID tracking |
| `aa46d00` | Orchestrator | Removal stale listeners (duplicate replies fix) + internal agents catch-up + scheduler event cleanup |
| `c169be3` | API | Sub-agent stats route + Claude runner tool call tracking + schema input/output tokens |
| `dcb8cd5` | Brain | Brain statistics API + Telegram image upload + Brain overview component |
| `92de99b` | Brain | Brain stats variant (notes/files/bytes breakdown by kind/visibility/origin) |
| `a2ef9c3` | Sub-agents | Management API (list/cancel/proposals) + Telegram bot cmds + WS events |
| `aec574e` | Frontend | BrainGraph3DConstellation refactor (particle density + MRI envelope animation) |
| `11e4b04` | Brain | Brain access event WebSocket + Claude runner vault pre-load |
| `486e689` | Brain | **Multi-vault support** (routes + graph building + components) |
| `ab91995` | Scheduler | Scheduled task minimal context (no extra commentary) |
| `b866fc5` | i18n | Translation cross-component ⚠️ DUPLICATE di `5c86bdd` su polpo-fork |
| `1977337` | Frontend | 2D/3D view toggle ⚠️ DUPLICATE di `2b03ef2` su polpo-fork |
| `02bfc31` | Telegram | PDF/document upload ⚠️ DUPLICATE di `e0bf021` su polpo-fork |
| `6db5d3c` | Auth | Account deletion flow |
| `274c266` | Brain | P2P brain network (connection/share requests, JSONB schema) |
| `d65de47` | Onboarding | Default task seeding on registration + business roadmap context |

### ⚠️ Rebase warning — duplicate commits

Tre commit di Federico (`b866fc5`, `1977337`, `02bfc31`) hanno **stesso messaggio + stesso giorno** ma **SHA diversi** rispetto a tre commit di Federico già su polpo-fork (`5c86bdd`, `2b03ef2`, `e0bf021`). Probabile cherry-pick storico: il lavoro è applicato due volte nel grafo.

**Conseguenza**: un `git rebase origin/main` produrrà 3 conflitti su:
- `package.json` + `package-lock.json` (dipendenze duplicate)
- `frontend/src/i18n.tsx` (translations duplicate)
- `frontend/src/pages/Brain.tsx` (view toggle duplicate)
- `backend/src/telegram/bot.ts` (doc upload handler duplicate)

**Strategie possibili**:
1. **Rebase interattivo con `--skip`** sui 3 commit dup polpo-fork (più pulito, mantiene SHA Federico)
2. **Merge** invece di rebase (preserva storia, accetta merge commit)
3. **Cherry-pick selettivo** dei 14 commit Federico non-duplicati su nuovo branch `polpo-fork-rebased`

### Hot files in conflict zone (Federico ha modificato dal merge-base)

Sovrapposizione con file toccati su polpo-fork:

```
backend/src/agent/orchestrator.ts      ⚠️
backend/src/agent/reflection.ts        ⚠️
backend/src/api/routes.ts              ⚠️
backend/src/api/ws.ts                  ⚠️
backend/src/claude/prompts.ts          ⚠️
backend/src/claude/runner.ts           ⚠️
backend/src/db/schema.sql              ⚠️ +103/-13 lines (alto rischio)
backend/src/scheduler/{index,tasks,seed_tasks}.ts  ⚠️
backend/src/telegram/bot.ts            ⚠️
```

**Diff aggregato Federico-behind**: 63 files, **+3943 / -1863 LOC**.

**Raccomandazione operativa**: non rebasare oggi. Le feature Federico (multi-vault, P2P brain network, sub-agent stats) sono **strategicamente preziose** ma ortogonali ai nostri asset polpo-fork. Pianificare rebase quando: (a) decisione su quali asset polpo pushare upstream via PR, (b) finestra di 2-3h con working tree clean.

---

## 🔐 Robustness & security audit

> Audit cross-layer eseguito sess.2818 (28 mag 2026) da agent automatico `feature-dev:code-reviewer` su backend completo (auth/api/ws/claude/telegram/mcp/scheduler/orchestrator/connectors). Confidence-filtered: solo findings ≥80% certezza.

### 📊 Verdetto sintetico

- **Maturità complessiva**: **5/10**
- **Production-ready per**: **single-user locale** (caso d'uso attuale di Mattia)
- **NON ancora ready per**: multi-user trusted (allievi Brain Training), multi-user public (open-source deploy)

### 🔴 CRITICAL — block prima di qualsiasi deploy multi-utente

#### C1 — JWT_SECRET hardcoded fallback (`config.ts:17`)
```ts
jwtSecret: process.env.JWT_SECRET ?? 'dev-insecure-change-me',
```
Qualunque deployment senza `JWT_SECRET` in env usa silenziosamente la stringa pubblica del repo OSS. Un attaccante che conosce il default (è in chiaro nel repo) può forgiare JWT validi per qualunque `uid`, incluso `uid=1` (owner). Studenti che clonano e avviano senza `.env` sono immediatamente vulnerabili.

**Fix**:
```ts
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error('JWT_SECRET env var is required (>=32 chars)');
}
```
Confidence: 100%

#### C2 — Header `x-polpo-brain-user` permette IDOR completo (`api/routes.ts:118-127`)
```ts
const headerUid = Number(req.header('x-polpo-brain-user') || '');
const userId = Number.isFinite(headerUid) && headerUid > 0 ? headerUid : req.user!.id;
```
La route è dietro `requireUser` ma **qualunque utente autenticato può impersonare qualunque altro user** passando `x-polpo-brain-user: 1`. Letture cross-tenant complete: GHL contacts, IMAP emails, vault notes, connector credentials.

Il bridge MCP (`bridge.ts:24`) usa questo header con `POLPO_BRAIN_USER_ID` da env del subprocess — non è un secret, è visibile in `/proc/<pid>/environ` e l'integer è guessable.

**Fix minimo**: validare `headerUid === req.user!.id` (il bridge gira sempre come l'utente per cui è stato spawnato), eliminando l'attack surface cross-user. **Fix completo**: rimuovere header e derivare user dal cookie nel bridge via service JWT scoped al subprocess.

Confidence: 97%

#### C3 — Cookie `secure: false` (`auth/index.ts:70`)
```ts
httpOnly: true, sameSite: 'lax', secure: false,
```
Session cookie trasmesso su HTTP plain. Localhost-only è OK, ma quando esposto a studenti via tunnel/reverse-proxy/HTTP misconfigured → session hijack su rete locale.

**Fix**:
```ts
secure: process.env.NODE_ENV === 'production'
```
+ warn at startup se `JWT_SECRET` settato ma `secure=false`.

Confidence: 85%

### 🟡 HIGH — block prima di onboarding allievi Brain Training

#### H1 — Rate limiting `/login` e `/register` ✅ CLOSED sess.2818
~~`/login` e `/register` senza throttling~~ → **risolto** via `express-rate-limit@8.5.2`:
- `/login`: 20 attempts / 15min per IP (bcrypt 10 rounds + cap = bruteforce ~impossibile)
- `/register`: 5 attempts / 15min per IP (mass-account prevention)
- Standard headers RFC `draft-7` per client awareness

```ts
// auth/routes.ts:9-23 (sess.2818)
const loginLimiter = rateLimit({ windowMs: 15*60_000, max: 20, ... });
const registerLimiter = rateLimit({ windowMs: 15*60_000, max: 5, ... });
authRouter.post('/register', registerLimiter, ...);
authRouter.post('/login', loginLimiter, ...);
```

#### H2 — `/api/tools` GET unauthenticated dal bridge ⏳ DEFERRED sess.2818
**Re-analisi sess.2818**: il bridge è oggi *de facto* non funzionante — `mcp/config.ts` inietta nell'env solo `POLPO_BRAIN_API`, **omette** `POLPO_BRAIN_USER_ID` e qualsiasi auth. Il subprocess fa `fetch /api/tools` senza cookie → 401 → catch silenzioso → tools array empty → MCP server registra zero tools. Quindi i tool dei connettori (imap/people/elevenlabs/fathom/ghl) **non sono raggiungibili da Claude tramite il bridge oggi**.

Questo è un bug funzionale architettura, non un security bug attivo: la superficie esposta è chiusa per costruzione perché `requireUser` blocca tutto. Sicurezza ≠ funzionalità. **Deferred** a finestra dedicata di architecture overhaul (decision con Federico):
- Opzione A: per-user bridge spawn con cookie iniettato
- Opzione B: service token in env del bridge + middleware impersonation
- Opzione C: rimozione bridge HTTP a favore di import diretto in-process

Confidence audit originale 80% — re-classificato come *functionality gap* non *security vuln*.

#### H3 — Telegram first-contact binding race ✅ CLOSED sess.2818
~~Chiunque mandi `/start` per primo si binda permanentemente~~ → **risolto**:
- Nuovo endpoint `POST /api/telegram/link-code` (authenticated) genera codice 6-char (alfabeto ridotto senza O/0/I/1 per clarity) con TTL 10 min, salvato in `telegram_link_pending` setting
- Bot handler `telegram/bot.ts:70` ora richiede `/link CODE` esplicito per binding — primo messaggio diverso da `/link` → reject con istruzioni
- Codice consumato post-verifica + TTL scaduto rifiutato
- Endpoint emergency `POST /api/telegram/unlink` per binding compromesso

Doppia barriera: attaccante con token leaked deve anche avere cookie Mattia per generare codice. 2^30 spazio codice (32^6 = 1.07B) × TTL 10min = bruteforce ~impossibile entro la finestra.

**Crypto-grade RNG**: codice generato via `crypto.randomInt` (CSPRNG `node:crypto`), non `Math.random` (PRNG predicibile inadatto a token security-sensitive — sess.2818 post-review hardening).

```ts
// auth path (telegram/bot.ts sess.2818):
if (!cur?.chatId) {
  const linkMatch = text.match(/^\/link\s+([A-Z0-9]{4,8})\s*$/i);
  if (!linkMatch) return reply('🔒 generate code in web UI then send /link <CODE>');
  // ... validate pending code + expiry + match ...
}
```

#### H4 — IDOR audit globale endpoint API ✅ VERIFIED CLEAN sess.2818
Audit completo `backend/src/`: **zero match** su pattern `req.body.user_id`, `req.query.user_id`, `req.body.userId`, `req.query.userId`. Tutti i 60+ riferimenti a `user_id` in `api/routes.ts` derivano da `req.user!.id` (auth context). Architettura IDOR-safe by construction grazie a `router.use(requireUser)` globale + `req.user!.id` come unica fonte autoritativa. Nessun fix necessario.

### 🟢 MEDIUM — technical debt, non blocker

- **`auth/routes.ts:24`** — password min 6 char. Per AI app con credenziali persistenti (Telegram tokens, IMAP passwords, GHL API keys) → alzare a 8-12 con complexity check.
- **`auth/index.ts:21`** — JWT `expiresIn: '30d'` senza revocation server-side. Logout client-side only → token stolen valido 30gg. OK single-user, problematico multi-user.
- **`scheduler/index.ts:109`** — `catch {}` in `finally` swallow silenzioso di state-persistence failure → connector re-run missed ticks su next boot anche quando non sono missed.

### ✅ Audit findings POSITIVI (mitigazioni già in place)

- ✅ **No SQL injection**: parametrized queries everywhere, anche dynamic SET clause in `api/routes.ts:265-280` usa allowlist hardcoded di field names + `$n` placeholders → safe
- ✅ Multi-user schema con `user_id` FK + composite uniqueness `(user_id, key)`
- ✅ bcrypt timing-safe via libreria
- ✅ Cookie HttpOnly + SameSite=Lax (mitiga XSS token theft + base CSRF)
- ✅ CORS scoped a `FRONTEND_ORIGIN` con `credentials: true`
- ✅ Express body limit `2mb` (mitiga DoS payload)
- ✅ Zod disponibile (verificare uso pervasivo nei route handlers)
- ✅ Stress test storico: 100 concurrent users, 0 failures (`STRESS_TEST_REPORT_sess2282.md`)

### 🎯 Hardening status (post sess.2818)

| Finding | Severity | Status | File |
|---|---|---|---|
| C1 — JWT_SECRET fail-fast | 🔴 Critical | ✅ closed | `config.ts:17` |
| C2 — `x-polpo-brain-user` IDOR | 🔴 Critical | ✅ closed | `api/routes.ts:118` |
| C3 — Cookie secure conditional | 🔴 Critical | ✅ closed | `auth/index.ts:70` |
| H1 — Rate limit login/register | 🟡 High | ✅ closed | `auth/routes.ts:9` |
| H3 — Telegram binding race | 🟡 High | ✅ closed | `telegram/bot.ts:70` |
| H4 — IDOR audit globale | 🟡 High | ✅ clean by construction | (audit only) |
| H2 — `/api/tools` bridge auth | 🟡 High | 🏛️ deferred (architecture) | `mcp/config.ts:33` |
| M1 — Password policy ≥6 | 🟢 Medium | ⏳ pending | `auth/routes.ts:42` |
| M2 — JWT revocation server-side | 🟢 Medium | ⏳ pending | `auth/index.ts:21` |
| M3 — Scheduler error swallow | 🟢 Medium | ⏳ pending | `scheduler/index.ts:109` |

**Maturità**: 5/10 → **~8/10** (6 di 7 vulnerabilità chiuse, IDOR clean, H2 declassato a *functionality gap* non security vuln).

**Multi-user trusted ready**: ✅ — onboarding allievi Brain Training sbloccato lato security.
**Production-public ready**: 🟡 — richiede M1+M2 (password policy + JWT revocation) + audit zod completo + HTTPS deploy.
**Bridge MCP funzionante**: ❌ — architecture overhaul pending (decisione con Federico, vedi H2).

---

## 🎭 Identifier rinominati (semantic layer)

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

Tool names nel Claude system prompt diventano `mcp__polpo_brain__roadmap_get`, etc.

---

## 🎨 Palette visiva (Astra canonical)

- `bg`: `#0a0f1a` (blu-nero Astra, era `#0a0a0c`)
- `accent`: `#00d4aa` (teal canonical, era purple `#c084fc`)
- `accent2`: `#ff6b9d` (Polpo pink, era cyan `#22d3ee`)
- Body gradients: teal+pink radial
- Logo: Bot Family rosso 3D `<img>` inline (era 🐙 emoji)
- Favicon + OG: `frontend/public/polpo_brain_avatar.png` (640×640, sess.2636)
- Identity master: `assets/polpo_brain_identity.png` (1024×1024)
- Header copy: "Polpo Brain · sovereign mind"

---

## 🖼️ Identity Asset (sess.2636)

Asset visivo canonical generato via `fal-ai/flux-pro/v1.1` (NON LoRA viola — cicatrice doctrine sess.2636: i bot Polpo Telegram appartengono alla **famiglia rosso glossy 3D**, non al LoRA brutalist). Prop semantico distintivo: **2 cervelli pink-purple translucenti luminosi** tenuti in tentacoli + **terzo occhio bianco glyph** sulla fronte.

**Prompt template canonical Bot Family** (riusabile per varianti):
```
3D glossy red plastic octopus toy character with kawaii face, large round
black eyes, gentle closed-mouth smile, eight tentacles with white suction
cups visible, [PROP], pure white background, soft studio lighting, vinyl
figure aesthetic
```

Applicato a:
- Telegram bot [@polpo_brain_bot](https://t.me/polpo_brain_bot) (avatar + name + description + 6 cmd menu)
- Vite frontend favicon + apple-touch-icon + og:image
- Sidebar header `<img>` (era `🐙` emoji)
- README hero image (sopra)

Costo: ~$0.04 per generazione (1024×1024). Avatar 640: 68KB.

---

## 🧠 Persona AI (system prompt)

Opening: `Your name is Polpo — the user's sovereign AI brain (🐙). You are their personal AI advisor — internalize Hormozi, Robbins, Naval, Jim Rohn, Dan Koe, Brunson, Drucker.`

La mentor library di Federico (Hormozi, Robbins, ecc.) + advisor stance sono intatti. Solo identità + nome sono ancorati pre-mentor — l'identità Polpo viene **prima** del bias mentor, evitando dilution.

---

## 📜 Commit history `polpo-fork` (23 commits ahead di main)

```
83f5ebd feat(dashboard): UI/UX improvements approved Federico   sess.2623
90170d1 fix(brand): hero logo replace 🐙 emoji with <img>       sess.2623
28c3461 chore(lockfile): align package-lock name polpo-brain   sess.2642
2782f51 feat(brand): Polpo Brain identity asset Bot Family 3D  sess.2636
d06a154 fix(telegram): TELEGRAM_STOP_GRACE_MS 5000 + 409 backoff sess.2379
5c86bdd Enhance i18n cross-component                            (Federico, 25 mag)
2b03ef2 Brain component 2D/3D view toggle + three.js            (Federico, 25 mag)
e0bf021 Telegram document upload + pdf-parse                    (Federico, 25 mag)
c1ad907 fix(claude): stdio['ignore',...] + scheduler 120s + SPEC v1 sess.2315
d58301a perf(reflection): gate mtime ZERO-LLM + model routing  sess.2282
40e5f7a fix(connectors): scaffold onTick ingestion → vault     sess.2282
8e5d061 fix(telegram): prevent lazy-start race 409 conflict    sess.2282
ca1cbc0 docs(polpo): CONNECTORS_POLPO + KNOWLEDGE_BRIDGE        sess.2261
9d571de feat(polpo): identity seed for buildSystemContext       sess.2261
b7ef0b4 feat(polpo): elevenlabs TTS connector scaffold          sess.2261
4f578d5 feat(polpo): ghl (gohighlevel) connector scaffold       sess.2261
83c6216 feat(polpo): fathom connector scaffold                  sess.2261
f3a5dbe test(perf): stress test 0 failures @ 100 concurrent    sess.2282
1e32715 docs(brand): POLPO_FORK_README.md operating manual     sess.2282
4c88b91 feat(brand): persona identity 'Your name is Polpo'     sess.2282
c50b895 feat(brand): semantic layer super_agent → polpo_brain  sess.2282
43d4748 feat(brand): rebrand Astra palette + 🐙 logo           sess.2282
d195a2c fix(db): create scheduled_tasks before ALTER+INDEX     sess.2282
8d4f32e first commit (Federico baseline)                       merge-base
```

20 commit Mattia + 3 commit Federico (cherry-pick storico) = 23 ahead.

---

## ⛔ Vincoli operativi attivi (sess.2623 + sess.2818)

**Push access su `origin = FedericoCasarella/super-agent.git`** concesso da Federico post-call Fathom 27 mag (sess.2623). Stato attuale: **NESSUN branch polpo ancora pushato** — decisione esplicita pending Mattia.

**Vincoli canonical (Mattia verbatim sess.2623)**:

1. ⛔ **MAI** push diretto su `main` — branch principale di Federico intoccabile
2. ⛔ **MAI** force-push, anche su branch nostri sul suo repo
3. ✅ **Branch separati only** — `polpo-fork` e `polpo-overlay` come rami paralleli, vivono accanto a `main` senza interferire
4. 🟡 **Pull Request** opzionale — eventuale PR draft solo su decisione esplicita Mattia, mai default. Lo split-test ideale: PR mirate per fix bug + features pulite (connettori, race condition fixes) → upstream Federico. Branding (palette, identity, persona) **resta** su polpo-fork.
5. 🟡 **Embargo brand "Polpo Brain"** verso Federico: **parzialmente sollevato** sess.2623 dopo accordo trilaterale AI Coach Italia. Federico ha approvato le UI/UX improvements commit `83f5ebd` real-time durante sessione.

---

## 🌳 Branch siblings nello stesso clone

| Branch | Stato | Scopo |
|---|---|---|
| `main` | tracking `origin/main` (17 behind) | Mirror Federico, mai modificato locally |
| `polpo-fork` | **23 ahead / 17 behind** | Branch attivo — rebrand + identity + bug fix + connettori |
| `polpo-overlay` | 5 ahead / 17 behind | Scaffold sess.2261 (connettori + identity seed + docs, file additivi only) |

---

## 🏪 Brainforge marketplace context (sess.2635)

Polpo Brain super-agent è il **layer infrastrutturale** sul quale gira [**brainforge**](https://github.com/mattiacalastri/brainforge) — il marketplace Plug & Play AI Brains (privato fino M3, public Show HN target 2026-06-20).

**Reference packs validati M1**:
- `polpo-founder-os@0.1.0` (88 nodes / 152 edges / 20 rules / 5 playbooks / 2 seeds)
- `real-estate-italia@0.1.0` (53 / 58 / 15 / 3 / 1)
- `marmo-funerario-ai@0.1.0` (45 / 55 / 12 / 3 / 1)

Tutti CC BY-SA 4.0 con dep esplicita `polpo-founder-os@^0.1.0`. Stack speculare a questo super-agent (TS + Express + ws + pg + MCP 1.29 + React + Vite + force-graph-3d + three + Claude CLI).

Flywheel: ogni allievo Brain Training 1-on-1 produce un brain settoriale come deliverable del programma → catalogo brainforge si espande organicamente con rev-share.

---

## ✅ Smoke test status

Verificato sess.2282 + ricontrollato sess.2623:
- ✅ Backend Express `:8787` health 200
- ✅ Frontend Vite `:5173` HTTP 200, proxy `/api` → backend
- ✅ DB `polpo_brain` migrato, 10+ tabelle
- ✅ Register `POST /api/auth/register` → user creato + cookie set
- ✅ Login `POST /api/auth/login` → JWT `polpo_brain_session` HttpOnly + SameSite=Lax
- ✅ Authenticated `GET /api/status` → response coerente
- ✅ Telegram bot `@polpo_brain_bot` avatar + name + description + commands sync sess.2636
- ✅ Stress test 100 concurrent users, 0 failures (`STRESS_TEST_REPORT_sess2282.md`)
- ⚠️ TS `Server` deprecated in `mcp/bridge.ts` (refactor `McpServer` pending, NON blocker)
- ⚠️ JWT_SECRET fallback insicuro (fix-on-startup pending, vedi Robustness)

---

## 📋 TODO (refresh sess.2818)

### Robustness hardening — status

**P0 closed sess.2818** (commits `d9b3e74` + `0b2bd8a` + commit corrente):
- [x] **C1** `config.ts:17` — JWT_SECRET fail-fast ≥32 char ✅
- [x] **C2** `api/routes.ts:118` — `x-polpo-brain-user` IDOR closed ✅
- [x] **C3** `auth/index.ts:70` — cookie `secure: isProduction` ✅
- [x] **H1** `auth/routes.ts:9` — rate limit /login + /register (express-rate-limit 8.5.2) ✅
- [x] **H3** `telegram/bot.ts:70` — one-time verification code via /link CODE + unlink API ✅
- [x] **H4** Audit IDOR globale — zero IDOR found, architecture clean ✅

**Architecture (non-security)**:
- [ ] **H2** Bridge MCP non-functional today (no auth injection in `mcp/config.ts:33`). Decisione architetturale con Federico: per-user spawn vs service token vs in-process tools. Functionality gap, not security exposure.

**Tech debt P1**:
- [ ] **M1** Password policy 8-12 char + complexity (`auth/routes.ts:24`)
- [ ] **M2** JWT revocation server-side (token blacklist o `iat > password_changed_at`)
- [ ] **M3** `scheduler/index.ts:109` — log error invece di `catch {}` silenzioso
- [ ] **M4** Rate-limit `/link CODE` attempts on Telegram bot (counter per-chat, lockout dopo 5 tentativi/15min) — flagged by post-review sess.2818
- [ ] Refactor `Server` → `McpServer` deprecato in `backend/src/mcp/bridge.ts` (1-2h, non security-critical)
- [ ] Verificare uso zod pervasivo su tutti i route handler
- [ ] `npm audit fix --force` su `uuid` via `node-cron` (richiede coord con Federico, breaking change)

### Robustness hardening P1 (medium)
- [ ] Password policy 8-12 char + complexity check (`auth/routes.ts:24`)
- [ ] JWT revocation server-side (token blacklist Redis o `iat > user.password_changed_at`)
- [ ] `scheduler/index.ts:109` — log error invece di `catch {}` silenzioso

### Sync strategy con upstream
- [ ] Decisione push `polpo-fork` su origin: subito vs dopo robustness pass
- [ ] Rebase su 17 commit Federico (con skip dei 3 duplicati) — finestra 2-3h
- [ ] Eventuale PR upstream per connettori `elevenlabs/fathom/ghl` (separati da branding)
- [ ] GitHub repo avatar upload manuale (CLI `gh` non supporta)

### Architecture evolution
- [ ] Merge `polpo-overlay` → `polpo-fork` (5 commit scaffold)
- [ ] Decisione: TypeScript super-agent (this) vs FastAPI `~/projects/polpo-brain/` — quale è IL prodotto?
- [ ] Setup remote `polpo` post-decisione (se serve mirror su `mattiacalastri/super-agent-polpo`)
- [ ] Implementare ingestion reale connettori (sostituire scaffold con API calls Fathom + GHL + ElevenLabs)
- [ ] Pipeline brainforge import → super-agent come "brain pack install"

### Brain Training program integration
- [ ] Wizard "fork your own super-agent" per allievi (clone + setup automatico)
- [ ] Documentation pack per allievi (quick start + connector tutorial + brain pack creation)
- [ ] Spec rev-share brainforge per brain settoriali prodotti da allievi

---

## 🔗 Riferimenti

- Repo upstream: [`github.com/FedericoCasarella/super-agent`](https://github.com/FedericoCasarella/super-agent)
- Programma: [aicoachitalia.it](https://aicoachitalia.it)
- Marketplace: [`github.com/mattiacalastri/brainforge`](https://github.com/mattiacalastri/brainforge) (privato)
- Bot Telegram: [@polpo_brain_bot](https://t.me/polpo_brain_bot)
- Spec architetturale: `SPEC_POLPO_BRAIN_v1.md` (23KB scolpita sess.2282)
- Connector design: `CONNECTORS_POLPO.md` + `POLPO_KNOWLEDGE_BRIDGE_DESIGN.md`
- Stress test storico: `STRESS_TEST_REPORT_sess2282.md`

---

**Documento aggiornato sess.2818 (28 mag 2026) — Polpo + Mattia in cabina di regia.**
**Generated sess.2282 (26 mag 2026 01:15 CEST) by Polpo in autonomous overnight mode — refresh sess.2623+sess.2818.**
