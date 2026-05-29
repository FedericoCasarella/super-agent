# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this project is

super-agent is a self-hosted personal AI agent: a TypeScript monorepo with a Node/Express backend and a Vite/React frontend. The agent talks to users on Telegram, reasons with the Claude Code CLI (`claude -p`, headless), keeps an Obsidian-style markdown brain indexed in Postgres, and acts through pluggable connectors exposed over the Model Context Protocol (MCP).

## Layout

```
backend/    Node + TypeScript — Express, ws, Telegraf, Postgres, node-cron
  src/
    index.ts             boot: orchestrator, scheduler, Telegram bots, connectors
    agent/               turn orchestration
    claude/              Claude Code CLI runner (claude -p, stream-json)
    connectors/builtin/  auto-loaded connectors (agent, imap, voice, people, tasks)
    db/                  Postgres pool + schema.sql + migrate.ts
    mcp/                 MCP bridge (connector tools → model)
frontend/   Vite + React + TypeScript + Tailwind
```

## Commands

```bash
npm install            # install workspace deps
npm run db:migrate     # apply backend/src/db/schema.sql (STANDALONE — not run on boot)
npm run dev            # backend (tsx watch) + frontend (vite)
```

- Backend type-check: `cd backend && npx tsc --noEmit`
- Frontend type-check: `cd frontend && npx tsc --noEmit`
- Backend build: `cd backend && npm run build` (tsc → dist/)

## Conventions

- **TypeScript everywhere**, ESM imports use the `.js` extension on relative paths (NodeNext resolution).
- **Migrations are idempotent**: `schema.sql` uses `CREATE TABLE IF NOT EXISTS` and runs statement-by-statement (one failure is logged and skipped, never rolls back). Re-running is safe.
- **The migration does NOT run on boot** — run `npm run db:migrate` after pulling schema changes.
- **Connector config lives in the DB** (`connectors` table, jsonb `config`), not in `.env`.

## Adding a connector

Create `backend/src/connectors/builtin/<name>/index.ts` exporting the `Connector` interface:

```ts
export default {
  manifest: { name: '<name>', title: '…', configSchema: [ /* … */ ] },
  tools: [ { name, description, inputSchema, handler } ],   // exposed to the model via MCP
  test: async (cfg) => ({ ok: true }),                      // optional live connectivity check
} satisfies Connector;
```

It is auto-loaded at the next boot — no registration step.

## Before you commit

- Run both type-checks (backend + frontend) — keep `tsc --noEmit` green.
- Never commit secrets. Connector credentials belong in the DB, not the repo.
- Keep changes scoped; this repo uses small, reviewable PRs.
