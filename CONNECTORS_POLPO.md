# Connettori Polpo — estensioni additive (sess.2261)

> Aggiunte di Mattia Calastri / Polpo OS al super-agent di Federico Casarella.
> **Additive + upstream-safe**: solo cartelle nuove in `backend/src/connectors/builtin/`,
> nessun file di Federico modificato → `git pull` upstream resta possibile.
> Decisione strategica + piano: vault `2.5 — Infrastructure/Polpo × Super-Agent (Casarella) — Decisione Entrabi-Separati + Piano sess.2261`.

## ⚠️ Stato: SCAFFOLD pending-test

Questi connettori sono scritti pattern-fedeli (clonati da `imap`/`people` + API reali verificate) ma **NON ancora eseguiti a runtime** (servono Postgres + `npm run dev` + le API key in config). Da validare con un tick reale prima di considerarli funzionanti.

## I connettori

| Connector | Fonte API verificata | onTick (proattivo) | Tools |
|---|---|---|---|
| `fathom` | `~/scripts/lib/fathom_api.py` | poll nuove call → summary nel brain (`calls/`) → segnale | list_meetings · get_summary · get_transcript · search |
| `ghl` | `~/mcp-servers/ghl/index.js` | poll opportunities → nuove/cambio-stage nel brain (`crm/`) → segnale | search_contacts · get_contact · search_opportunities · get_pipelines |
| `elevenlabs` | `~/scripts/voice_briefing.py` | — (solo tool) | speak (TTS → mp3) |

> Il built-in `voice` copre già lo **STT** (Whisper). `elevenlabs` aggiunge il **TTS** (parlare). Insieme = voce bidirezionale.
> Il built-in `imap` copre già **Gmail** (basta configurarlo con host imap.gmail.com + app-password). Connettore Gmail-API dedicato = opzionale futuro.

## Wiring

1. `npm install` (root) + `npm run db:migrate -w backend` + `npm run dev`
2. UI onboarding → abilita i connettori, inserisci le config:
   - **fathom**: `apiKey` (Fathom external API key, X-Api-Key)
   - **ghl**: `pitToken` (Private Integration Token) + `locationId` (+ `apiVersion` default `2021-07-28`)
   - **elevenlabs**: `apiKey` + `voiceId` (es. Andy M) + `modelId` opzionale (`eleven_turbo_v2_5`)
3. I connettori con `schedule` (fathom `*/15`, ghl `*/10`) partono al boot; al primo tick fanno **baseline only** (marcano lo stato attuale senza inondare brain/Telegram), poi ingeriscono solo le novità.

## TODO additivi — stato aggiornato sess.2261

- [x] **Identity layer Polpo** — seed pronto in `polpo_identity_seed/meta/user-profile.md`. Copialo nel tuo brain vault dopo onboarding: il file viene letto da `buildSystemContext` (claude/prompts.ts:88-93) e iniettato come *"LIVE USER BEHAVIORAL PROFILE — MIRROR this tone"*. **Zero hack di prompts.ts.**
- [x] ~~**Classificatore info-sensibili**~~ — **già esistente**: `agents/internal/brain_classifier.ts` classifica ogni nota come `visibility: protected | public` via path + kind + keyword (password/IBAN/CF/P.IVA/secret/token/bearer/private/contratto/NDA/medical/stipendio/pagamento ricevuto). Gira daily 04:00. *Recon ha evitato il doppione.*
- [ ] **Knowledge Bridge** — il vero gap residuo: ENFORCER inter-agente che filtra `visibility=public` quando un altro agente chiede al mio brain. Design completo in `POLPO_KNOWLEDGE_BRIDGE_DESIGN.md` (default-deny + audit log + peer auth). **NON buildare prima del gate Federico** (è collaborazione formale, non tecnica).
- [ ] **Telegram voice-out**: cablare `elevenlabs.speak` → invio voice note via Telegraf (tocca `telegram/bot.ts` di Federico → con accordo o via hook additivo).
- [ ] **Gate IP/revenue con Federico** — call **mer 27 h17:00**. Prerequisito per portare valore Polpo nel suo repo (track PRODOTTO).

## Principio

Convenzione fork `_polpo` (vedi `project_ascii_video_player_polpo_fork_sess2240`): si estende, non si modifica l'upstream. Config-driven, zero secret hardcoded (tutte le key via `configSchema` → DB per-user).
