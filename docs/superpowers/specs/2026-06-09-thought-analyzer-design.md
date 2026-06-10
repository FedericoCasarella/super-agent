---
title: Thought Analyzer — diario cognitivo + ingestione knowledge-graph via Telegram
date: 2026-06-09
session: 8266
status: approved (max-autonomy mandate, Mattia)
host: super-agent (@polpo_brain_bot) — backend Node/Telegraf/Postgres
---

# Thought Analyzer

## 1. Cosa fa (in una frase)
Butti un pensiero grezzo nel bot Telegram; lui lo **analizza** (tema, emozione, loop)
**e** lo trasforma in un **nodo connesso** nel second brain (vault Obsidian), con
backlink automatici alle sinapsi esistenti. La sera, un **digest** trova i pattern
che nei singoli pensieri non si vedono.

Combinazione richiesta da Mattia: **A (diario cognitivo) + C (knowledge graph)**, al
**livello 3** (real-time leggero + digest serale profondo).

## 2. Perché si innesta, non si costruisce
Il super-agent ha già tutte le primitive:
- `bus.emit('telegram:incoming')` + `bot.command(...)` → canale d'ingresso.
- `brain/vault.ts::writeNote(userId, relPath, frontmatter, body)` → crea nodo vault.
- Il grafo (`brain/graph.ts`) cuce i backlink da `related:` frontmatter + wikilink `[[...]]`.
- `agents/internal/registry.ts` → agenti schedulati per-utente con catch-up anti-downtime,
  notifica Telegram via `humanize()`, link-ai-file via `created_paths`.
- `claude/runner.ts::runClaude(userId, prompt, {useMcp:false})` → unico canale LLM (CLI `claude`,
  modello `claude-sonnet-4-6`). `useMcp:false` = spawn lean, niente caricamento MCP.

Tutto il lavoro è **additivo**: 1 tabella, 1 modulo, 1 internal agent, +wiring di 2 comandi.
Nessuna modifica distruttiva al routing conversazionale esistente.

## 3. Componenti (unità isolate)

### 3.1 `thoughts` table (storage di prima classe)
```sql
CREATE TABLE IF NOT EXISTS thoughts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'telegram',   -- telegram | voice | api
  emotion TEXT,                               -- popolato dall'analisi leggera
  themes JSONB NOT NULL DEFAULT '[]'::jsonb,  -- string[]
  backlinks JSONB NOT NULL DEFAULT '[]'::jsonb, -- string[] (titoli note vault)
  vault_path TEXT,                            -- nodo creato, relativo al vault
  analyzed BOOLEAN NOT NULL DEFAULT false,
  digested_on DATE                            -- data del digest che l'ha aggregato
);
CREATE INDEX IF NOT EXISTS thoughts_user_ts_idx ON thoughts(user_id, ts DESC);
```
Motivo: un messaggio nel flusso conversazionale sparisce; un pensiero è un oggetto
aggregabile nel tempo (la condizione necessaria per trovare i loop).

### 3.2 `brain/thoughts.ts` (cattura + analisi leggera real-time)
- `captureThought(userId, text, source)` → INSERT immediato, ritorna `{id}`. **Deterministico,
  zero latenza** → l'ack istantaneo non aspetta l'LLM.
- `candidateBacklinks(userId, text)` → query su `brain_index` (titoli/path) con match per
  keyword → lista candidati. **Zero LLM** (così l'analisi non ha bisogno di tool/MCP).
- `analyzeThoughtLight(userId, id, text)` → **un solo** `runClaude({useMcp:false, timeoutMs:45s})`
  con prompt che riceve il pensiero + i candidati backlink e ritorna JSON
  `{emotion, themes[2-3], backlinks[≤3 dai candidati], loop_hint?}`. Poi:
  1. UPDATE riga `thoughts` (emotion, themes, backlinks, analyzed=true).
  2. `writeNote` → `thoughts/YYYY-MM-DD-HHMM-<slug>.md` con frontmatter
     `kind: thought, emotion, themes, related: [[...]], visibility: protected`.
  3. ritorna una sintesi 1-2 righe per il follow-up Telegram.
- **Degradazione graziosa**: se il `runClaude` fallisce/timeout → l'ack resta, la riga
  resta `analyzed=false`, il digest serale la recupererà comunque.

`visibility: protected` di default — sono pensieri personali (coerente con `brain_classifier`).

### 3.3 `agents/internal/thought_digest.ts` (digest serale, internal agent)
- `name: 'thought_digest'`, `defaultHour: 21`, `defaultMinute: 0`.
- `run(userId)`: legge i pensieri **ultimi 7 giorni** dalla tabella (DB, niente tool) →
  **un** `runClaude({useMcp:false})` con prompt che chiede: emozione dominante di oggi,
  loop ricorrente (cluster di temi), contraddizione viva (pensieri che si tirano contro),
  una domanda per domani. Riceve i pensieri come testo nel prompt → deterministico, niente FS.
- Scrive il nodo digest `thoughts/digests/YYYY-MM-DD.md` (con `related:` ai pensieri del giorno
  + ai nodi vault toccati) e marca i pensieri del giorno con `digested_on`.
- `report.created_paths` = [digest node] → il pipeline esistente appende il link Telegram.
- `humanize()` → card serale (emozione dominante, loop, contraddizione, domanda).
- Se 0 pensieri oggi → report `{skipped:true}`, `humanize` → SKIP (niente notifica vuota).

### 3.4 Wiring `telegram/bot.ts` (+2 comandi, additivo)
- `bot.command('think', ...)` → `captureThought` + ack istantaneo (`🐙 Salvato.`) +
  `analyzeThoughtLight` async (typing indicator → follow-up con tema/emozione/backlink).
- `bot.command('thoughts', ...)` → lista i pensieri di oggi (count + temi) e toggle
  **thought-mode** (`/thoughts on|off`).
- **thought-mode** (setting `thought_mode`, default **OFF**): quando ON, ogni messaggio di
  testo viene trattato come pensiero (short-circuit PRIMA di `bus.emit('telegram:incoming')`),
  così non serve digitare `/think`. Default OFF = il bot conversazionale resta intatto.
- +2 voci in `COMMAND_CATALOG` per il menu `/`.

## 4. Flusso dati
```
/think "pensiero"  ──► captureThought ──► INSERT thoughts (instant)
                                   └──► ack "🐙 Salvato."
                          (async) ──► analyzeThoughtLight
                                        ├─ candidateBacklinks (brain_index)
                                        ├─ runClaude useMcp:false → JSON
                                        ├─ UPDATE thoughts (emotion/themes/backlinks)
                                        ├─ writeNote thoughts/...md (related: backlinks)
                                        └─ follow-up Telegram (tema+emozione+1 backlink)

21:00  ──► internal agent thought_digest.run
              ├─ SELECT thoughts last 7d
              ├─ runClaude useMcp:false → pattern/loop/contraddizione
              ├─ writeNote thoughts/digests/YYYY-MM-DD.md
              ├─ UPDATE thoughts SET digested_on=today
              └─ humanize → card Telegram + link al digest node
```

## 5. Error handling
- Cattura DB-first: l'ack non dipende mai dall'LLM.
- `analyzeThoughtLight` e `thought_digest` isolano i fallimenti `runClaude` (try/catch →
  riga resta `analyzed=false` / report `error`); il pipeline `runInternalAgent` già gestisce
  lo stato `error` + notifica.
- `writeNote` lancia se vault non configurato → catturato, il pensiero resta in DB.
- thought-mode default OFF → zero rischio di dirottare l'agente conversazionale.

## 6. Testing
- Unit: `captureThought` (insert+shape), `candidateBacklinks` (match keyword su brain_index),
  parsing JSON robusto di `analyzeThoughtLight` (input malformato → fallback).
- Integrazione (manuale, bot non-prod): `/think` → riga DB + nodo vault + follow-up;
  `thought_digest` run manuale via endpoint `runInternalAgent` → digest node + card.
- Build: `npm run build` (tsc) verde prima di qualunque deploy.

## 7. Non-goals (YAGNI)
- Niente UI frontend dedicata in questa iterazione (i nodi sono già navigabili in /brain).
- Niente sentiment-scoring numerico / grafici emozione (il digest è narrativo).
- Niente multi-utente tuning: gira per l'utente Mattia, ma il codice è già per-userId.
- Niente deploy/restart del bot vivo senza gesto esplicito di Mattia.

## 8. Decisioni prese in autonomia (mandato Mattia)
- Livello **3** confermato.
- Digest **21:00** (post `evening-commit` 19:00, così non si pestano).
- Cattura via `/think` esplicito + thought-mode opzionale **OFF di default**.
- Analisi leggera con `runClaude useMcp:false` (no Anthropic SDK: non presente nel repo).
- `visibility: protected` sui nodi pensiero.
- Tono bot: asciutto, 🐙, coerente con gli internal agent esistenti.
