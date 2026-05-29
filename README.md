# super-agent

Personal AI agent. Telegram-driven, Claude Code backed, second-brain aware.

## Stack
- Backend: Node + TS, Express, ws, Telegraf, Postgres, node-cron
- Frontend: Vite + React + TS + Tailwind
- LLM: Claude Code CLI (`claude -p` headless)
- Brain: Obsidian-style markdown vault + Postgres index

## Quick start
```bash
cp .env.example .env
# edit DATABASE_URL
createdb super_agent
npm install
npm run db:migrate
npm run dev
```
Open http://localhost:5173 → onboarding wizard.

## Connectors
Drop folder in `backend/src/connectors/builtin/<name>` with `manifest.json` + `index.ts` exporting `Connector` interface. Auto-loaded at boot.

Built-in: `imap` (email reader + reply drafts), `voice` (speech-to-text via Groq/OpenAI Whisper), `elevenlabs` (text-to-speech), `fathom` (call recordings + summaries), `ghl` (GoHighLevel CRM), `people` (people intelligence), `tasks` (scheduled tasks), `agent` (agent controls).
