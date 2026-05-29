<div align="center">

# 🐙 super-agent

### Not a chatbot. A second brain that *acts*.

**A personal AI agent that lives in your Telegram, thinks with Claude Code, remembers everything in an Obsidian-style brain — and asks before it touches the real world.**

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)
![Postgres](https://img.shields.io/badge/Postgres-4169E1?logo=postgresql&logoColor=white)
![Claude](https://img.shields.io/badge/Claude%20Code-D97757?logo=anthropic&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-enabled-8A63D2)
![Self-hosted](https://img.shields.io/badge/self--hosted-✓-success)

[Quick start](#-quick-start) · [What it does](#-what-it-does) · [How it works](#-how-it-works) · [How it compares](#-how-it-compares) · [FAQ](#-faq)

</div>

---

## ✨ The idea

Most AI assistants forget you the moment the tab closes, and most "second brains" only *store* — they never *do*.

**super-agent is both.** It keeps a living memory of every conversation, call, and document in a markdown vault you own, and it acts on that memory through pluggable connectors — reading email, transcribing voice, running scheduled jobs, spawning sub-agents. The whole thing lives in your Telegram, thinks with the Claude Code CLI, and follows one rule above all:

> **Autonomous in thought, deliberate in action.** Anything irreversible is *proposed*, never executed — you approve with a single tap.

---

## 🚀 What it does

- **🧠 Second brain** — every conversation, call, and document is distilled into a markdown vault (Obsidian-style), indexed in Postgres and explorable as a live knowledge graph.
- **💬 Telegram-native** — the agent lives in your chat. Talk to it like a person; it replies, reacts, and keeps context across turns.
- **🗺️ Roadmap-driven** — it doesn't just answer, it *advances*. It tracks your open goals and steers each reply toward the highest-leverage next step instead of drifting.
- **🤖 Parallel sub-agents** — hand it several deliverables and it proposes a batch of background agents; approve with one tap and watch them run from the `/agents` view.
- **🎙️ Voice in** — send a voice note, get an accurate transcription via Whisper (Groq / OpenAI / custom endpoint).
- **📧 Email, with a safety net** — reads your inbox over IMAP and *drafts* replies; nothing is ever sent until you tap ✅ on Telegram.
- **⏰ Scheduled tasks** — recurring jobs run on cron and report back into the chat.
- **🔌 MCP bridge** — connector tools are exposed to the model over the Model Context Protocol, so Claude can call them natively.

### Human-in-the-loop by default
Every action with real-world consequences — sending an email, spawning agents — is *proposed*, not executed. You confirm with an inline ✅ / ❌ on Telegram. The agent moves fast in thought and slow in commitment, on purpose.

---

## 🏗️ How it works

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

## 🔌 Connectors

Built-in (auto-loaded at boot):

| Connector | What it does |
|-----------|--------------|
| `agent`   | Agent self-controls — quiet hours, sleep/wake, and the roadmap engine that drives the conversation. |
| `imap`    | Reads one or more mailboxes into the brain and drafts replies with human-in-the-loop approval. |
| `voice`   | Speech-to-text via Whisper (Groq / OpenAI / custom). |
| `people`  | People intelligence — who's who across your conversations. |
| `tasks`   | Scheduled, recurring tasks surfaced back into chat. |

Each connector exposes typed tools to the agent through the MCP bridge. Adding one is a single folder — see [Extending it](#-extending-it).

---

## ⚖️ How it compares

super-agent sits in the gap between two worlds — note apps that only remember, and AI assistants that only chat.

| | Note apps (Obsidian-style) | Chat assistants | **super-agent** |
|---|:---:|:---:|:---:|
| Markdown second brain you own | ✅ | ❌ | ✅ |
| Knowledge graph | ✅ | ❌ | ✅ |
| Actually *does* things (email, tasks, agents) | ❌ | partial | ✅ |
| Lives in your messaging app | ❌ | partial | ✅ |
| Parallel background agents | ❌ | ❌ | ✅ |
| Human-in-the-loop approvals | — | rare | ✅ |
| Self-hosted, your data | ✅ | ❌ | ✅ |

The point isn't to replace your notes app or your chatbot — it's to be the layer that **remembers like the first and acts like the second**, on infrastructure you control.

---

## 🚀 Quick start

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

## 🧩 Extending it

Drop a folder in `backend/src/connectors/builtin/<name>/` with an `index.ts` that exports the `Connector` interface (`manifest`, optional `tools`, `onTick`, `onMessage`, `test`). It's auto-loaded at the next boot — no registration needed.

```ts
export default {
  manifest: { name: 'my-connector', title: 'My Connector', /* … */ },
  tools: [ /* typed tools exposed to the agent */ ],
  test: async (cfg) => ({ ok: true }), // optional live connectivity check
} satisfies Connector;
```

---

## ❓ FAQ

**What is super-agent?**
A self-hosted personal AI agent. It runs on your machine, talks to you on Telegram, reasons with the Claude Code CLI, and keeps a markdown second brain it can act on through connectors.

**How is it different from a chatbot?**
A chatbot answers and forgets. super-agent remembers everything in a vault you own, pursues your goals across sessions, and *takes action* — drafting emails, running scheduled tasks, spawning sub-agents — always with your one-tap approval.

**Is my data private?**
Yes. It's self-hosted: the brain is plain markdown on your disk, indexed in your own Postgres. Nothing leaves your infrastructure except the model calls you configure.

**Which model does it use?**
The Claude Code CLI (`claude -p`, headless). Connector tools are exposed to it over the Model Context Protocol (MCP).

**Do I need to code to use it?**
No — connect a Telegram bot through the onboarding wizard and you're talking to it. Coding is only needed to add new connectors.

---

## 🛠️ Stack

- **Backend:** Node · TypeScript · Express · ws · Telegraf · Postgres · node-cron
- **Frontend:** Vite · React · TypeScript · Tailwind
- **LLM:** Claude Code CLI (`claude -p`, headless)
- **Brain:** Obsidian-style markdown vault + Postgres index
- **Protocol:** Model Context Protocol (MCP)

---

<div align="center">

**Built with care by [Federico Casarella](https://github.com/FedericoCasarella) and contributors.**

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) · Found a security issue? [SECURITY.md](SECURITY.md)

*A second brain that remembers like a vault and acts like an agent — on infrastructure you own.*

⭐ If this resonates, star the repo.

</div>
