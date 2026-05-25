# Knowledge Bridge — Design (sess.2261)

> **Stato: design-only, non implementato.** Documenta l'unico pezzo veramente mancante per il caso d'uso multi-agente che Mattia e Federico hanno discusso in call (25 mag 2026).

## Il caso d'uso

> *"Mattia chiede al super-agent di Federico: «cosa sai tu Federico di Toni Gallito?» → l'agente di Federico accede al brain di Federico, ma RESTITUISCE solo info condivisibili. Le info sensibili (es. «gli ultimi 10 pagamenti che ha ricevuto Federico») restano in un vault privato e non escono."*

## Cosa esiste già (non duplicare)

`agents/internal/brain_classifier.ts` **classifica già** ogni nota come `visibility: protected | public`:
- Path: `inbox/email/`, `meta/` → protected
- Kind: `email`, `roadmap` → protected
- Keyword: password / IBAN / CF / P.IVA / secret / token / bearer / private / contratto / NDA / medical / stipendio / pagamento ricevuto → protected
- Override esplicito da frontmatter `visibility:` vince sempre.

La **classificazione c'è**. Manca **l'ENFORCER**: lo strato che, quando un altro agente chiede, filtra i risultati per `visibility = public` e NON espone i protected.

## Architettura proposta (additiva, upstream-safe)

### 1. HTTP endpoint inter-agente

`POST /bridge/query` sul backend del super-agent:

```jsonc
// request
{
  "from_agent": "federico-super-agent-instance-id",
  "auth_token": "shared-secret-or-jwt",        // Bearer-style, per-peer
  "query": "cosa sai di toni gallito",
  "max_results": 10
}
// response (200)
{
  "results": [
    {
      "path": "people/toni-gallito.md",
      "snippet": "...solo testo public...",
      "frontmatter": { /* solo campi non-sensibili */ }
    }
  ],
  "filtered_out": 3,             // numero di note protected escluse (count, non contenuto)
  "policy_version": "1.0.0"
}
```

### 2. Filtro hard

Pseudocodice (in `api/bridge.ts` nuovo file, additivo):

```ts
const matches = await searchVault(userId, query);
const allowed = matches.filter((m) => m.frontmatter?.visibility === 'public');
// NB: default deny — se visibility è null/undefined, NON è public.
return { results: allowed.slice(0, max_results), filtered_out: matches.length - allowed.length, ... };
```

**Regola madre: default-deny.** `visibility` assente o `protected` → MAI esposto. Solo `visibility: public` esplicito esce.

### 3. Audit log

Ogni richiesta inter-agente → log persistente in tabella `bridge_audit`:
- `ts, from_agent, query, results_count, filtered_out, ip, user_agent`
- Telegram notify a Mattia al ricevimento (almeno la prima volta da un dato peer + giornaliero summary).

### 4. Auth peer-to-peer

Tabella `bridge_peers(user_id, peer_name, shared_secret, allowed_queries_per_day, enabled)`.
Federico genera un suo secret, Mattia lo aggiunge come peer abilitato (e viceversa). Rate-limit.

### 5. Default-deny anche sui campi frontmatter

Anche per le note `public`, escludere i campi frontmatter sensibili (es. `email`, `phone`, `iban`, `monetaryValue`) salvo `bridge_expose: true` esplicito. Sanitize before send.

## Cosa NON fare in v1

- **Niente "Mattia chiede di te"** in vivo bidirezionale: v1 è solo "altro-agente → mio-brain", una direzione per volta.
- **Niente embedding/semantic search**: solo grep/keyword sull'indice già esistente. La semantic search aggiunge attack surface, rimandata a v2.
- **Niente esposizione di transcripts Fathom / email body**: anche se `public`, restituire solo *summary* o *snippet ≤300 char*, non corpi interi. Riassumere a sua volta è un canale leak — rimandato.

## Sequenza implementazione (quando si decide di buildare)

1. Migration: aggiungere colonna `bridge_audit` + `bridge_peers` allo schema.
2. `api/bridge.ts` con il filtro default-deny + audit.
3. `bridge_peers` UI in frontend (aggiungere/rimuovere peer + rate limit).
4. Test con 2 istanze locali (Mattia + Federico) prima di esporre fuori localhost.
5. Reverse-proxy con HTTPS + Cloudflare prima di usare cross-rete.

## Premortem (cosa può andare storto)

1. **Default-permit invece di default-deny**: una nota senza `visibility:` viene esposta → leak. Fix: enforce `visibility === 'public'` strict.
2. **Sanitization frontmatter parziale**: `bridge_expose` non gestito uniformemente → numeri sensibili escono. Fix: whitelist esplicita per ogni `kind`.
3. **Audit log non letto**: Mattia non si accorge che Federico ha fatto 1000 query in una notte → privacy leak silenziosa. Fix: telegram notify giornaliero summary + alert se >50 query/h.
4. **Peer auth compromesso**: Federico's instance hacked → query a tappeto. Fix: secret rotabile + rate limit + IP allowlist opzionale.
5. **Public ≠ shareable**: una nota classificata `public` dalla heuristic ma in realtà sensibile (es. cliente non vuole nome pubblicato). Fix: revisione manuale Mattia dei `public` prima di abilitare bridge.

## Decisione

Bridge **NON va costruito ora**. Prerequisiti:
- ✅ brain_classifier in funzione (esiste)
- ⏳ Revisione Mattia delle classificazioni prima volta (1 ora di lettura)
- ⏳ Accordo IP/revenue con Federico (gate mer 27 h17:00) — un bridge tra le nostre istanze è collaborazione formale, non gesto tecnico
- ⏳ Definizione dei `kind` esposti (people sì? projects sì? roadmap no? finanza no?)

Decidere la build solo dopo questi 4 step. Anti-pattern build-and-abandon.
