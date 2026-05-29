# Contributing to super-agent

Thanks for your interest in improving super-agent. This project is small and fast-moving — contributions that are focused and well-scoped get merged quickly.

## Getting started

```bash
git clone https://github.com/FedericoCasarella/super-agent.git
cd super-agent
cp .env.example .env        # set DATABASE_URL
createdb super_agent
npm install
npm run db:migrate          # standalone — not run on boot
npm run dev                 # backend (tsx watch) + frontend (vite)
```

Open http://localhost:5173 for the onboarding wizard.

## Before you open a PR

- **Type-check both sides** — keep them green:
  ```bash
  cd backend  && npx tsc --noEmit
  cd frontend && npx tsc --noEmit
  ```
- **No secrets in the repo.** Connector credentials live in the database (`connectors` table), never in committed files.
- **Keep PRs small and single-purpose.** One change, one reason — easy to review, easy to revert.
- **Match the surrounding style.** TypeScript everywhere; ESM relative imports use the `.js` extension (NodeNext).

## Adding a connector

The cleanest way to extend the agent. Create `backend/src/connectors/builtin/<name>/index.ts` exporting the `Connector` interface (`manifest`, optional `tools`, `onTick`, `onMessage`, `test`). It's auto-loaded at the next boot — no registration step. See [AGENTS.md](AGENTS.md) for the full shape.

## Commit messages

Conventional Commits are appreciated (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`) — they keep the history readable and the changelog easy.

## Reporting bugs & requesting features

Use the issue templates. For anything security-related, **do not open a public issue** — see [SECURITY.md](SECURITY.md).

## Code of conduct

Be kind and constructive. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
