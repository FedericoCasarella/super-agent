<p align="center">
  <img src="frontend/public/rounded-image.png" alt="super-agent logo" width="140" />
</p>

<h1 align="center">super-agent</h1>

<p align="center">
  <em>A personal AI agent that lives in your Telegram, thinks with Claude Code, and grows a second brain that maintains itself.</em>
</p>

<p align="center">
  <img src="frontend/public/super-agent.png" alt="super-agent demo" width="100%" />
</p>

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Postgres](https://img.shields.io/badge/Postgres-4169E1?logo=postgresql&logoColor=white)
![Claude](https://img.shields.io/badge/Claude%20Code-D97757?logo=anthropic&logoColor=white)

Chat with it on Telegram. It reasons with the Claude Code CLI, keeps a growing Obsidian-style knowledge vault, and acts through pluggable connectors — reading your email, transcribing voice notes, spawning parallel sub-agents — always asking before it does anything irreversible.

### Why it's different

Two products already own half of this idea. **Obsidian** gives you a knowledge vault and a graph — but it doesn't *think*. **OpenClaw** gives you an autonomous agent across channels — but it doesn't *remember* in a navigable brain. super-agent is the only one that fuses both: **a living second brain that is also an agent.**

| | Knowledge brain (vault + graph) | Autonomous agent | Connectors / messaging |
|---|:---:|:---:|:---:|
| **Obsidian** | ✅ static, no agent | ❌ | ❌ plugins only |
| **OpenClaw** | ❌ | ✅ | ✅ 10+ channels |
| **super-agent** | ✅ vault + 3D graph | ✅ | ✅ imap · whatsapp · telegram · voice |

---

## What it does

- **🧠 Second brain** — every conversation, call, and document is distilled into a markdown vault (Obsidian-style), indexed in Postgres and explorable as a knowledge graph in the web UI.
- **💬 Telegram-native** — the agent lives in your chat. Talk to it like a person; it replies, reacts, and keeps context across turns.
- **🗺️ Roadmap-driven** — it doesn't just answer, it *advances*. The agent tracks open discovery items and steers each reply toward the highest-leverage next step instead of drifting.
- **🤖 Parallel sub-agents** — hand it several deliverables and it proposes a batch of background agents; you approve with one tap and watch them run from the `/agents` view.
- **🎙️ Voice in** — send a voice note, get an accurate transcription via Whisper (Groq / OpenAI / custom endpoint).
- **📧 Email, with a safety net** — reads your inbox over IMAP and *drafts* replies; nothing is ever sent until you tap ✅ on Telegram.
- **⏰ Scheduled tasks** — recurring jobs run on cron and report back into the chat.
- **🔌 MCP bridge** — connector tools are exposed to Claude over the Model Context Protocol, so the model can call them natively.

### Human-in-the-loop by default
Every action with real-world consequences — sending an email, spawning agents — is *proposed*, not executed. You confirm with an inline ✅ / ❌ on Telegram. The agent is autonomous in thought, deliberate in action.

---

## The brain that runs itself

super-agent isn't a chatbot that sits idle until you type. **Six internal agents run on their own cron schedule** — classifying, connecting, profiling, pruning, ingesting and *dreaming* — so the second brain keeps growing and stays healthy even when no one is at the keyboard.

| Agent | Cadence | What it does |
|-------|---------|--------------|
| **🏷️ Brain Classifier** | nightly | Tags every note as protected or public (frontmatter + index). Deterministic — zero LLM cost. |
| **🪢 Link Weaver** | nightly | Finds the 1–6 best related notes per note and writes them into `related:` frontmatter. Deterministic — zero LLM cost. |
| **🧬 People Analyzer** | daily | Builds a psychological profile — fears, levers, relational style — of each person, from every brain node linked to them. |
| **🌿 Vault Gardener** | daily | Prunes orphan / stale notes (archived, never deleted), waters thin-but-central notes with fresh content, plants MOC seeds for tag clusters. |
| **📚 Vault Librarian** | every 3h | Pulls the best writing in your sector — top GitHub repos, live RSS — filters by relevance, dedups by URL, files it into the vault. |
| **🌙 Vault Dreamer** | nightly | Samples distant notes and surfaces unexpected connections — a serendipity engine that dreams for you while you sleep. |

Each runs on a configurable schedule, reports back into Telegram, and toggles from the `/agents` view. The deterministic agents (classify, link) cost nothing; the creative ones (gardener, librarian, dreamer) call Claude only when they actually act.

---

## How it works

```
Telegram  ──▶  Orchestrator  ──▶  Claude Code CLI (claude -p, headless)
   ▲                │                       │
   │                ▼                       ▼
   │           Connectors  ◀──MCP──▶   tools (email, voice, tasks, …)
   │                │
   └── approvals    ▼
            Second brain (markdown vault + Postgres index)
                    │
                    ▼
            Web dashboard (graph · agents · logs · settings)
```

- **Backend** — Node + TypeScript, Express, WebSocket, Telegraf, Postgres, node-cron. Boots the orchestrator, the scheduler, the Telegram bots, and the connector registry.
- **Reasoning** — the Claude Code CLI in headless mode (`claude -p`, streamed JSON), with per-turn tool tracking.
- **Brain** — an Obsidian-style markdown vault plus a Postgres index for fast retrieval and graph building.
- **Frontend** — Vite + React + TypeScript + Tailwind: dashboard, knowledge graph, connector config, live agents, logs, settings.

---

## Connectors

Built-in (auto-loaded at boot):

| Connector | What it does |
|-----------|--------------|
| `agent`   | Agent self-controls — quiet hours, sleep/wake, and the roadmap engine that drives the conversation. |
| `imap`    | Reads one or more mailboxes into the brain and drafts replies with human-in-the-loop approval. |
| `voice`   | Speech-to-text via Whisper (Groq / OpenAI / custom). |
| `people`  | People intelligence — who's who across your conversations. |
| `tasks`   | Scheduled, recurring tasks surfaced back into chat. |

Each connector exposes typed tools to the agent through the MCP bridge.

---

## Quick start

```bash
cp .env.example .env
# edit DATABASE_URL
createdb super_agent
npm install
npm run db:migrate
npm run dev
```

Open **http://localhost:5173** → onboarding wizard → connect your Telegram bot and you're talking to your agent.

> **Heads up:** the migration is a standalone step (`npm run db:migrate`) — it does **not** run automatically on boot. Re-run it after pulling schema changes.

---

## Extending it

Drop a folder in `backend/src/connectors/builtin/<name>/` with an `index.ts` that exports the `Connector` interface (`manifest`, optional `tools`, `onTick`, `onMessage`, `test`). It's auto-loaded at the next boot — no registration needed.

```ts
export default {
  manifest: { name: 'my-connector', title: 'My Connector', /* … */ },
  tools: [ /* typed tools exposed to the agent */ ],
  test: async (cfg) => ({ ok: true }), // optional live connectivity check
} satisfies Connector;
```

---

## Stack

- **Backend:** Node · TypeScript · Express · ws · Telegraf · Postgres · node-cron
- **Frontend:** Vite · React · TypeScript · Tailwind
- **LLM:** Claude Code CLI (`claude -p`, headless)
- **Brain:** Obsidian-style markdown vault + Postgres index
