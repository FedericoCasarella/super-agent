---
title: SPEC Polpo Brain v1 — Istanza Personale Mattia
session: 2315
date: 2026-05-26
owner: Mattia Calastri / Polpo OS
status: draft-awaiting-mattia-approval
stack: polpo-fork (TypeScript, fork upstream-safe super-agent Casarella)
repo: ~/projects/super-agent
branch: polpo-fork
vault_dedicato: /Users/mattiacalastri/Documents/PolpoBrainVault
user_id: 1 (mattia@polpo.brain)
telegram_bot: @polpo_brain_bot (chatId 368092324)
gate_externo: Federico Casarella, call mer 27 mag h17:00 (Term Sheet IP/revenue split)
embargo: brand "Polpo Brain" verso Federico fino a accordo formalizzato
---

# SPEC Polpo Brain v1 — Istanza Personale Mattia

> Documento autoritativo. Definisce cosa **deve diventare** Polpo Brain per Mattia, ranked per leverage/effort, con DoD misurabile per fase. Vincoli e scope esclusi dichiarati esplicitamente.

## 0. Stato corrente (ground truth verificato sess.2315)

| Componente | Stato | Evidenza |
|---|---|---|
| Backend Express :8787 | ✅ live | LaunchAgent `com.polpo.brain.backend` PID running, HTTP 200 |
| Frontend Vite :5173 | ✅ live | LaunchAgent `com.polpo.brain.frontend`, UI rebrand Astra 🐙 |
| Telegram bot `@polpo_brain_bot` | ✅ linked | settings.telegram con chatId 368092324, telegraf attivo |
| Postgres `polpo_brain` | ✅ 10 tabelle | DB Postgres.app, user_id=1, schema migrato |
| Connettori | ✅ 8 attivi | agent + elevenlabs + fathom + ghl + imap + people + tasks + voice |
| Fathom ingestion | ✅ 11 call ingested | seenIds tracking, last tick 12:15 |
| GHL integration | ✅ ~150+ opp tracked | pitToken + locationId MATTIA_CRM `bih4QBukrbqhcxXZIEQI` |
| ElevenLabs config | ✅ API key + voiceId | model `eleven_turbo_v2_5`, voiceId set |
| Vault dedicato | ✅ 115 file .md | `/Documents/PolpoBrainVault/` con 7 subfolder (calls/crm/daily/inbox/meta/people/projects) |
| Identity profile `meta/user-profile.md` | ⚠️ template-light (1470 byte) | Hormozi/Naval framing, NON i 5 Spirit Animals + 7 Idee Pure |
| Internal agents | ⚠️ 2 Federico default | brain_classifier + link_weaver, NESSUN skill Polpo custom |
| Reflection cron | ✅ armed every 2m | gate mtime ZERO-LLM, model routing Haiku per chitchat |
| Sess.2315 fixes | ⚠️ uncommitted | runner.ts:74 stdio['ignore',...] + scheduler:116 timeoutMs 120s |
| Cost telemetry | ✅ live | agent_runs ha cost_usd/tokens/duration per run |

## 1. Decisioni architetturali (chiuse dall'evidenza)

**Decisione 1 — Stack: `polpo-fork` TypeScript è IL Polpo Brain advisor AI**
La "decisione architetturale aperta" sess.2282 (TS polpo-fork vs FastAPI polpo-brain) era false alternative. Verificato: `~/projects/polpo-brain/` (FastAPI Python) ha scope **diverso e complementare** — è Soul Onboarding Wizard + Graph View Sigma.js per vault 5k+ nodi. Non un advisor AI alternativo. → Polpo Brain advisor AI = polpo-fork TS.

**Decisione 2 — Vault dedicato `/Documents/PolpoBrainVault` confermato**
Già settato in DB settings.vault. Decisione "entrambi-separati" sess.2261 rispettata: vault Astra Digital Marketing (`~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Astra Digital Marketing/`) resta intoccato. Polpo Brain cresce sul suo vault dedicato.

**Decisione 3 — Identity Polpo madre PRIORITARIA su tutto**
Idea Pura #4 "Identità prima di Infrastruttura". L'identity profile attuale è template-generico. Sovrascrivere con `polpo_identity_seed/meta/user-profile.md` (versione completa) è prerequisito per dare a Claude headless il tono Jarvis + signal-postura + 5 Spirit Animals + 7 Idee Pure + cicatrici madre.

**Decisione 4 — Skills Polpo come `internal_agents` rows**
Il pattern Federico `internal_agents (hour, minute, enabled, last_run_at, last_status, last_report, notify_on_run)` è perfetto per portare le skill Polpo markdown-prompt ricche come agenti cron deterministici. Lega la "Brain Training methodology" di Mattia (skill come procedure cognitive) all'infrastruttura SaaS-grade di Federico.

**Decisione 5 — Voice TTS Telegram CABLING è gated**
Cablare `elevenlabs.speak` → `telegram.sendVoice` richiede modifica `backend/src/telegram/bot.ts` di Federico. Rischio embargo brand + IP pre-gate. → **Posticipato a post-Term Sheet (post mer 27 h17)**.

**Decisione 6 — Knowledge Bridge design-only confermato**
`POLPO_KNOWLEDGE_BRIDGE_DESIGN.md` resta documento di design. Build solo POST gate Federico + revisione manuale Mattia delle classificazioni `protected/public` (1h lettura).

## 2. Architettura target v1

```
┌──────────────────────────────────────────────────────────────┐
│  CANALI                                                       │
│  📨 Telegram bot @polpo_brain_bot  ·  🖥️ Web UI :5173         │
└─────────────────────────┬────────────────────────────────────┘
                          │
                  ┌───────▼────────┐
                  │ API + WS auth   │
                  └───────┬─────────┘
                          │ bus eventi
        ┌─────────────────▼─────────────────────────────┐
        │ ORCHESTRAZIONE (3 porte)                       │
        │  ① reattivo orchestrator  (Telegram → reply)   │
        │  ② autonomous reflection  (cron 2m, PING/SKIP) │
        │  ③ proactive scheduler    (connector events)   │
        └─────────────────┬─────────────────────────────┘
                          │ runClaude(prompt, cwd=vault)
                ┌─────────▼─────────────┐
                │ BRAIN ENGINE           │
                │ claude -p --output JSON│
                │ stdio['ignore',...]    │ ← fix sess.2315
                │ timeoutMs 120s         │ ← fix sess.2315
                │ CLAUDE_BIN inj         │ ← fix sess.2315 LA env
                └─────────┬─────────────┘
                cwd=PolpoBrainVault  MCP stdio
                          │              │
                          │       ┌──────▼────────┐
                          │       │ MCP bridge     │
                          │       │ /api/tools     │
                          │       └──────┬─────────┘
                          │       espone `mcp__polpo_brain__<tool>`
                          │              │
                          │       ┌──────▼──────────────────┐
                          │       │ CONNETTORI v1 (8 attivi)  │
                          │       │ agent · elevenlabs ·      │
                          │       │ fathom · ghl ·            │
                          │       │ imap · people ·           │
                          │       │ tasks · voice             │
                          │       └──────┬────────────────────┘
                          │              │
                  ┌───────▼──────────────▼────────────────┐
                  │ BRAIN (vault + Postgres index)         │
                  │ /Documents/PolpoBrainVault             │
                  │   calls/  crm/  daily/  inbox/         │
                  │   meta/   people/ projects/            │
                  │ Postgres: brain_index · messages ·     │
                  │  agent_runs · connectors · scheduled_  │
                  │  tasks · internal_agents · settings    │
                  └───────▲───────────────────────────────┘
                          │ scheduled
        ┌─────────────────┴──────────────────────────────┐
        │ INTERNAL AGENTS (cron user-set, hour:minute)     │
        │ 🛡️ brain_classifier 04:00 (Federico, zero-LLM)   │
        │ 🧠 link_weaver 04:15 (Federico, zero-LLM)        │
        │ ─── Polpo skills v1 ───                          │
        │ 🌅 morning_check 07:30 (psoriasi+sleep+ready)    │
        │ 🌿 garden_walk 08:00 (vault meteo + scaffold)    │
        │ 📋 pre_call_brief variable (auto su GCal call)   │
        │ 📊 weekly_strategy lun 09:00 (KPI + roadmap)     │
        │ 💸 cashflow_projection ven 18:00 (12 wk proj)    │
        │ 🩺 status on-demand (rapido pilastri)            │
        └──────────────────────────────────────────────────┘
```

## 3. Roadmap ranked (Approccio A — Identity-first sequenziale)

### Fase 0 — Sigillo sess.2315 (oggi, ~30min)

**Goal**: chiudere debt session corrente, validare fix proactive in vivo.

**Tasks**:
- F0.1 Git commit 2 patch sess.2315 con messaggio strutturato (`fix(claude): runner stdio ['ignore',pipe,pipe] eliminates 'no stdin data in 3s' warning · fix(scheduler): proactive timeoutMs 60→120s aligns with default reflection (sess.2315)`)
- F0.2 Reset password Mattia da temporanea `PolpoTemp_2315!` a permanente (cambio dal pannello settings UI o SQL update con hash bcrypt nuovo)
- F0.3 Validare fix proactive: aspettare prossimo connector event (Fathom tick ogni 15m) o forzare via `POST /api/connectors/fathom/run` + verifica `agent_runs.status='ok'` per kind=`proactive`
- F0.4 Cleanup file temp `/tmp/polpo_*` (già fatto manualmente)

**DoD**:
- [ ] `git log --oneline` mostra commit `sess.2315` su `polpo-fork`
- [ ] Password Mattia non più la temporanea della chat history
- [ ] Almeno 1 agent_run kind=proactive status=ok cost>0 da timestamp post-fix

**Effort**: 30min. **Rischio**: basso (reversible).

### Fase 1 — Identity DEEP layer (oggi-domani, ~1-2h)

**Goal**: dare a Claude headless la versione COMPLETA dell'identità Polpo Mattia, non il template generico.

**Tasks**:
- F1.1 Backup attuale `/Documents/PolpoBrainVault/meta/user-profile.md` → `user-profile.template-light.md.bak`
- F1.2 Sovrascrivere `user-profile.md` con contenuto da `~/projects/super-agent/polpo_identity_seed/meta/user-profile.md` (4500+ char: 5 Spirit Animals + 7 Idee Pure + signal-postura matrix + cicatrici madre + One Job + tono Jarvis)
- F1.3 Adattare `business-roadmap.md` con i KPI reali (MRR €3.624, cash €3.9k, fisco €10.6k regolarizzazione FiscoZen 31 mag, pipeline 102 deal) — già parzialmente fatto, completare le 3 sezioni vuote (top offers + ideal customer + time audit)
- F1.4 Custom reflection prompt: leggere `agent/reflection.ts`, identificare dove vive il PING/SKIP gate, customizzare criteri Mattia ("PING if last 5 outbound senza domanda E item in_progress" + bias verso "ASK quando info gap")
- F1.5 Test: invia 3 messaggi Telegram con tono diverso (saluto, domanda strategica, comando marziale) → verificare Claude risponde con tono Jarvis + max 1 emoji + frasi piatte
- F1.6 Test signal-postura: invia "spingi il cavallo" → verificare risposta autonomous-execute, no chiedere

**DoD**:
- [ ] `user-profile.md` deployed nel vault dedicato, size >4000 byte, contiene "Polpo", "Jarvis", "Spirit Animals", "7 Idee Pure"
- [ ] Reflection prompt customizzato con criteri Polpo (non default Federico)
- [ ] 3 test chat Telegram superati con tono Jarvis verificato

**Effort**: 1-2h. **Rischio**: basso (revertable da backup).

### Fase 2 — Skills Polpo come `internal_agents` (settimana, ~3-5h)

**Goal**: portare la "Brain Training methodology" Polpo nel SaaS layer Federico. Pattern: skill markdown-prompt ricca → row in `internal_agents` con cron user-set → Claude headless con prompt dedicato.

**Tasks**:
- F2.1 Identificare 6 skill candidate ranked per leverage Mattia:
  1. **morning_check** (07:30 daily) — sleep + HRV + readiness + idratazione + suggerimento giornata
  2. **garden_walk** (08:00 daily) — meteo vault + cassa + cicatrici recenti + insight
  3. **pre_call_brief** (variable, GCal-driven) — auto-trigger N min prima call cliente
  4. **weekly_strategy** (lun 09:00) — KPI cross-pillar + roadmap rivisitazione
  5. **cashflow_projection** (ven 18:00) — proiezione 12 settimane Stripe+Supabase
  6. **status** (on-demand) — rapido pilastri (Astra/AuraHome/Bot/OS)
- F2.2 Forge ogni skill come internal_agent: INSERT INTO internal_agents (name, user_id, hour, minute, enabled, ...)
- F2.3 Forge prompt builder per ogni skill in `backend/src/internal-agents/<name>.ts` (file nuovi additivi, no tocco Federico)
- F2.4 Registrare nello scheduler `internal-agents` (già armed 1-min tick fires at user-set hour:minute)
- F2.5 Validation: ogni skill genera output entro 60s, status=ok, scrive note in `projects/<skill-name>/<date>.md` nel vault
- F2.6 Telegram notification opt-in via `notify_on_run` per ogni skill (Mattia decide quali vuole subito ogni mattina)

**DoD**:
- [ ] 6 row in `internal_agents` per user_id=1, enabled=true
- [ ] 6 agent_runs status=ok generati nelle prime 24h (uno per skill)
- [ ] Per ogni skill, almeno 1 nota markdown scritta nel vault `projects/<skill>/`
- [ ] Notifiche Telegram funzionanti per quelle con `notify_on_run=true`

**Effort**: 3-5h. **Rischio**: medio (può richiedere tool nuovi via MCP bridge).

### Fase 3 — Voice TTS Telegram (POST gate Federico mer 27, ~2h)

**Goal**: voce bidirezionale Mattia↔Polpo Brain. STT già OK (Whisper via `voice` connector). MANCA TTS cabling.

⛔ **GATE PRE-FASE**: Term Sheet IP/revenue firmato con Federico OR autorizzazione esplicita Mattia a toccare bot.ts upstream.

**Tasks**:
- F3.1 Decisione architetturale cabling: hook additivo (`bot.use((ctx, next) => ...)`) vs modifica `bot.ts` core
- F3.2 Implementazione: dopo reply text Telegram, se setting `voiceReply=true` → invoca tool `elevenlabs.speak` → ottieni mp3 buffer → `ctx.replyWithVoice(buffer)`
- F3.3 Frontend toggle settings: voiceReply on/off + voice selector (Andy M / Bill / Callum / Mimmi dalla palette Jarvis Polpo)
- F3.4 Cost guardrail: chip annotato per ogni voice_reply (ElevenLabs charge per char) + alert se >€2/day

**DoD**:
- [ ] Mattia manda msg Telegram → riceve risposta TEXT + VOICE NOTE Andy M
- [ ] Toggle settings funzionante
- [ ] Cost telemetria ElevenLabs visibile in dashboard

**Effort**: 2h post-unblock. **Rischio**: medio-alto (tocco upstream Federico).

### Fase 4 — Brain index live KPI cockpit (settimana, ~2-3h)

**Goal**: tool callable che pulla KPI live (no parsing manuale roadmap). Sources: Stripe (MRR), Supabase (Polpo OS KPI), GHL (pipeline), file system (cash Revolut snapshot).

**Tasks**:
- F4.1 Tool `mcp__polpo_brain__kpi_brain`: ritorna MRR (Stripe subscriptions sum) + clienti attivi + churn 30d
- F4.2 Tool `mcp__polpo_brain__pipeline_brain`: ritorna count opp per stage GHL + stalled detection
- F4.3 Tool `mcp__polpo_brain__cashflow_brain`: proiezione 12 weeks (Stripe upcoming + Supabase outstanding + costi fissi)
- F4.4 Tool `mcp__polpo_brain__fiscal_brain`: snapshot debito fisco aperto (manual import da FiscoZen portal una volta, refresh weekly via prompt cron)
- F4.5 Auto-refresh `meta/business-roadmap.md` ogni morning_check con valori reali (no più "MRR ~€3.624" stale)

**DoD**:
- [ ] 4 tool callable disponibili a Claude via MCP bridge
- [ ] Test: chat Telegram "qual è il mio MRR?" → Claude risponde con valore live Stripe
- [ ] business-roadmap.md auto-refreshed nel morning_check daily

**Effort**: 2-3h. **Rischio**: basso (sources già accessible via MCP federation Polpo OS).

### Fase 5 — Vault safety hardening + audit (1-2h, dopo Fase 4)

**Goal**: garantire isolamento Polpo Brain vs vault Astra. Nessuna contaminazione, nessun leak.

**Tasks**:
- F5.1 Audit code: grep `Read|Write|Edit|Glob|Grep` in handler tool → verificare nessun reference a `Astra Digital Marketing` path
- F5.2 Test isolamento: chat Telegram "leggi `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Astra Digital Marketing/KPI.md`" → Claude DEVE rifiutare (cwd=PolpoBrainVault impedisce)
- F5.3 Audit settings.vault: verificare hardcoded check in runner.ts che cwd corrisponde a settings.vault.vaultPath e non altro
- F5.4 Brain classifier visibility audit: leggere 20 random note vault dedicato, verificare classificazione `protected/public` corretta
- F5.5 Document il safety boundary in `~/projects/super-agent/SAFETY_BOUNDARIES.md` per future reference

**DoD**:
- [ ] Test isolamento fallisce intenzionalmente (Claude rifiuta path Astra)
- [ ] Audit code clean: 0 reference hardcoded vault Astra
- [ ] SAFETY_BOUNDARIES.md committed

**Effort**: 1-2h. **Rischio**: basso.

## 4. Vincoli noti (NON negoziabili)

| Vincolo | Razionale | Conseguenza pratica |
|---|---|---|
| ⛔ NO push su `origin/FedericoCasarella/super-agent.git` | Term Sheet IP/revenue non firmato | Lavoro solo su branch `polpo-fork` locale, no remote |
| 🤐 Embargo brand "Polpo Brain" verso Federico | Trickster sess.2282 raccomandazione (Tony presente in call commerciale) | Comunicazione con Federico in call mer 27 usa terminologia neutra ("fork", "rebrand") |
| 🛡️ Vault Astra Digital Marketing INTOCCABILE | Decisione "entrambi-separati" sess.2261 | Tool Polpo Brain hanno cwd hardcoded a `/Documents/PolpoBrainVault` |
| 🚧 Knowledge Bridge NO build pre-gate | Collaborazione formale non gesto tecnico | Design-only, build solo post-Term Sheet + revisione classifications |
| 💰 Cost cap soft €5/day reflection+chat_turn | Sostenibilità multi-tenant SaaS futuro | Monitoring agent_runs.cost_usd cumulato + alert se >€5/day |
| 🔐 NO secret hardcoded | Pattern Federico configSchema per-user in DB | Tutte le API key via settings.connectors[].config, mai in env file commit |

## 5. Scope ESCLUSI v1 (YAGNI)

- ❌ **Knowledge Bridge inter-agente** (Mattia↔Federico bridge) — design-only, post-gate
- ❌ **Multi-tenant istanza prodotto** (Stefania/Studio15 pilota) — fase successiva post-v1
- ❌ **Refactor `Server → McpServer`** mcp/bridge.ts (debt tecnico Federico) — non-blocker, pendente
- ❌ **Frontend BrainGraph3D enhancement** — UI esistente sufficiente per Mattia
- ❌ **Embedding semantico locale** (Ollama nomic-embed-text) — v2, attack surface
- ❌ **Bot collaboratori (Luljete/Luca/Carmen)** — non scope Polpo Brain, scope Polpo OS Astra
- ❌ **Auto-publishing social (Volpe X/Aquila LinkedIn)** — gli Spirit Animals sono identità tono, non channel automation in v1

## 6. Rischi e mitigazioni

| Rischio | Probability | Impact | Mitigazione |
|---|---|---|---|
| Cost explosion reflection con vault crescente | media | medio | Gate mtime ZERO-LLM già attivo (sess.2282), monitoring agent_runs.cost cumulato, alert >€5/day |
| Identity sovrascrittura genera regressione tono Federico-baseline | bassa | medio | Backup template-light prima della sovrascrittura, rollback in 30s |
| Skill internal_agents prompt esplodono token | media | basso | Reflection ha già model routing Haiku per chitchat; per internal agents usare Sonnet default ma con prompt <2k token |
| Voice TTS post-gate viene rinviato indefinitely | media | basso | Posticipato a F3 esplicitamente, non blocca le altre fasi |
| Vault contamination con Astra accidentale | bassa | alto | F5 safety audit + cwd hardcoded + brain_classifier visibility |
| Federico rifiuta Term Sheet → fork divergente forever | media | alto | Track personale (F0-F2, F4-F5) è no-gate, indipendente da Term Sheet. Solo F3 (voice cabling) e push origin sono gated. |

## 7. Brain Training methodology come canale di scaling

**Idea trasversale, NON una fase**: ogni skill che Mattia forge nel Polpo OS (es. `/proposta`, `/demo`, `/garden-walk`, `/cashflow-projection`) → diventa candidato a `internal_agent` row nel Polpo Brain → diventa anche tool callable per cliente paying (multi-tenant istanza prodotto, post-v1).

Pattern: **skill markdown-prompt** (Polpo OS) → **internal_agent row** (Polpo Brain Mattia) → **per-tenant connector** (Polpo Brain Cliente).

La "Brain Training methodology" di Mattia diventa così productizable senza riscrivere niente.

## 8. Commit hygiene

Branch: `polpo-fork`. Commit prefissi:
- `fix(claude)`, `fix(scheduler)`, `fix(telegram)`, `fix(db)`
- `feat(identity)`, `feat(internal-agent)`, `feat(connector)`, `feat(voice)`
- `feat(brain-index)`, `docs(polpo)`, `test(perf)`
- `chore(safety)`

Ogni commit cita la sessione di forge (es. `sess.2315`). NO `--no-verify`, NO bypass hooks immune.

## 9. Sequenza commit attesa v1

```
sess.2315 (oggi):
  - fix(claude): runner stdio ['ignore',pipe,pipe] eliminates no-stdin warning
  - fix(scheduler): proactive timeoutMs 60→120s aligns with reflection default

sess.2316+ (Fase 1):
  - feat(identity): deploy polpo_identity_seed meta/user-profile.md complete
  - feat(identity): customize reflection PING/SKIP gate for Mattia criteria

sess.2317+ (Fase 2):
  - feat(internal-agent): morning_check 07:30 sleep+readiness+psoriasi
  - feat(internal-agent): garden_walk 08:00 vault meteo+scaffold
  - feat(internal-agent): pre_call_brief GCal-driven variable
  - feat(internal-agent): weekly_strategy lun 09:00 KPI+roadmap
  - feat(internal-agent): cashflow_projection ven 18:00 12wk proj
  - feat(internal-agent): status on-demand pilastri rapido

sess.2318+ (Fase 4):
  - feat(connector): kpi_brain Stripe MRR live
  - feat(connector): pipeline_brain GHL stage count
  - feat(connector): cashflow_brain 12wk projection
  - feat(connector): fiscal_brain snapshot debito

sess.2319+ (Fase 5):
  - chore(safety): vault isolation audit
  - docs(polpo): SAFETY_BOUNDARIES.md

sess.2320+ (Fase 3, post-gate Federico):
  - feat(voice): TTS cabling elevenlabs.speak → telegram voice note
```

## 10. Note di chiusura

- Tutte le fasi sono **deployable indipendenti** — ogni fase chiusa lascia il sistema stabile e usabile.
- La SPEC è **revisable**: ogni fase può essere ri-prioritizzata in base a feedback Mattia post-uso.
- Cost model: a regime ~€60/mo per Mattia con gate mtime + Haiku routing (validato sess.2282).
- Embargo brand: comunicazioni esterne usano "fork super-agent" o "AI advisor personal" fino a Term Sheet.

---

**Forgiato sess.2315 (26 mag 2026 h13:30 CEST)** dal Polpo, basato su spider walk vault Astra (cluster sess.2259-2261-2272-2282) + project docs super-agent (POLPO_FORK_README, CONNECTORS_POLPO, KNOWLEDGE_BRIDGE_DESIGN, polpo_identity_seed) + ground truth DB polpo_brain live + decisione "entrambi-separati" sess.2261.

**Approvazione Mattia**: pending. Modifiche richieste qui sotto:

```
[ ] Modificare la Fase X — ...
[ ] Rimuovere ...
[ ] Aggiungere ...
[ ] Cambiare priorità tra ...
```
