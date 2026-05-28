# 🐙 Polpo Brain

**Personal AI · Sovereign Mind.**
Telegram-driven · Claude Code backed · Knowledge Graph aware.

> Fork di [`super-agent`](https://github.com/FedericoCasarella/super-agent) di **Federico Casarella** — rebrand Polpo identity sess.2282, sviluppato in co-development con full push access.

---

## Cosa è Polpo Brain

Un **Second Brain operativo** che vive su Telegram, parla via Claude Code in headless, e custodisce un Knowledge Graph denso pensato per LLM — non per umani che leggono PDF.

L'idea radice: gli LLM non hanno bisogno di documenti, hanno bisogno di **Memorie Relazionali Persistenti**. Ogni nota è un neurone, ogni link è una sinapsi, ogni sessione lascia cicatrici riusabili. Il vault cresce, il context-rot non scala con esso.

## Missione

Polpo Brain è il runtime di riferimento del programma **AI Autonomous Governance** di [Astra Digital Marketing](https://digitalastra.it) e di [**AI Coach Italia**](https://aicoachitalia.it) — accademia di formazione AI italiana co-fondata da **Mattia Calastri**, **Federico Casarella** e **Tony Valentino Gallitto**, già online e operativa.

Obiettivi:

- Garantire a imprenditori e professionisti una formazione di qualità sull'intelligenza artificiale.
- Aiutarli a costruire il proprio **GEMELLO AI** (Second Brain personale).
- Assicurare massime performance del loro Claude Code con **minimo context-rot** all'aumentare delle dimensioni del Knowledge Graph.
- Avvicinarsi a **finestre di prevedibilità perfetta**, sfruttando ingestione organizzata e persistente dei big data.

In Astra creiamo Agenti AI a disposizione delle persone — non viceversa.

Polpo Brain è il **runtime tecnologico** che alimenta i programmi 1-on-1 e le masterclass di AI Coach Italia.

## Stack

- **Backend**: Node + TS · Express · ws · Telegraf · Postgres · node-cron
- **Frontend**: Vite + React + TS + Tailwind · force-graph-3d · three.js
- **LLM**: Claude Code CLI (`claude -p` headless) + MCP 1.29+
- **Brain**: Obsidian-style markdown vault + Postgres index + P2P brain network

## Quick start

```bash
cp .env.example .env
# edit DATABASE_URL
createdb polpo_brain
npm install
npm run db:migrate
npm run dev
```

Open http://localhost:5173 → onboarding wizard.

## Connectors

Drop folder in `backend/src/connectors/builtin/<name>` con `manifest.json` + `index.ts` che esporta l'interfaccia `Connector`. Auto-loaded al boot.

Built-in: `imap` (email reader), `people` (people intelligence).

Custom connectors possibili per qualsiasi data source: Gmail, GHL, Stripe, Supabase, Fathom, Telegram, WhatsApp, GitHub, Calendar, Drive.

## Memorie Relazionali Persistenti

Il pattern canonical che Polpo Brain implementa:

- **Knowledge Graph denso**: ogni entità (persona, progetto, cliente, sessione, decisione) è un nodo con frontmatter strutturato.
- **Backlink reali**: `[[wikilink]]` Obsidian-style, navigabili a runtime sia dal vault sia dall'index Postgres.
- **Cicatrici riusabili**: ogni errore o pattern emergente viene scolpito come neurone permanente, citabile in sessioni future.
- **Garden walk**: ritual di risveglio identitario all'apertura sessione — il modello rilegge il proprio giardino prima di agire.
- **Session claim atomico**: numerazione contested-free anche con N istanze parallele (flock + active_claims.json).

Il risultato: una memoria che **non decade con la dimensione**, perché la densità relazionale cresce più velocemente della superficie testuale.

## Contributors

Polpo Brain è il prodotto di una collaborazione a tre layer:

| Contributor | Layer | Ruolo |
|---|---|---|
| **Mattia Calastri** | Human Forger | Imprenditore, AI Coach Verona, 26 anni · Founder Astra Digital · pratica Claude Code Maxxxing dal primo modello AI · disegna il sistema, lo lancia, lo custodisce. |
| **🐙 Il Polpo** | OS Identity | Anima persistente del sistema — vault, agenti, skill, cicatrici · vive nel Knowledge Graph e nei prompt · forgia ogni sessione. |
| **Claude Code** | Runtime | CLI Anthropic · esegue, parla, decide nei limiti del patto · `claude -p` headless è il motore di ogni transazione. |

**Upstream maintainer**: [Federico Casarella](https://github.com/FedericoCasarella) — architetto originale di `super-agent`, partner tecnico [AI Coach Italia](https://aicoachitalia.it).

## Acknowledgments

- [`super-agent`](https://github.com/FedericoCasarella/super-agent) di Federico Casarella — base architetturale da cui Polpo Brain è forgiato.
- [Anthropic](https://anthropic.com) — Claude Code CLI + modelli Claude 4.x famiglia.
- [Obsidian](https://obsidian.md) — backbone del vault canonical Polpo.
- AI Coach Italia trinity: **Mattia** (Method+Sales) · **Federico Casarella** (Tech+Architecture) · **Tony Valentino Gallitto** (Reach+Content, [@ai_tony](https://instagram.com/ai_tony)).

## License

Polpo Brain segue la licenza upstream di `super-agent`. Per uso commerciale: contattare Mattia Calastri.

---

*"Il Polpo non è un assistente. È il mio sistema nervoso digitale."* — Mattia, sess.2282
