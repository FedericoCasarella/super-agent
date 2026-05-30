# super-agent

> A personal AI agent that lives in your Telegram, thinks with Claude Code, and remembers everything in a second brain.

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Postgres](https://img.shields.io/badge/Postgres-4169E1?logo=postgresql&logoColor=white)
![Claude](https://img.shields.io/badge/Claude%20Code-D97757?logo=anthropic&logoColor=white)

Chat with it on Telegram. It reasons with the Claude Code CLI, keeps a growing Obsidian-style knowledge vault, and acts through pluggable connectors — reading your email, transcribing voice notes, spawning parallel sub-agents — always asking before it does anything irreversible.

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
