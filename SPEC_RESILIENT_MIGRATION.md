# SPEC — Resilient per-statement migration (upstream contrib)

**Status:** approved (design) · **Target:** `contrib/resilient-migration` → PR to `FedericoCasarella/super-agent`
**Scope:** narrow (1 PR, migration only)

## Problem

`backend/src/db/migrate.ts` runs the entire `schema.sql` as a single
`pool.query(sql)`. In Postgres a multi-statement simple query executes inside
one implicit transaction: if **any** statement fails, the **whole migration
rolls back**.

Observed failure: a unique index (`users_singleton`, enforcing single-user)
could not be created over pre-existing duplicate rows. That single failure
rolled back the entire migration, leaving later tables (`agent_proposals`,
`sub_agents`, …) uncreated. The backend then crashed on a query against a
missing relation and entered a restart crash-loop.

This bug is present identically on `origin/main` (verified) — it is a genuine
upstream reliability issue, not a fork artifact.

## Goal

A migration that applies every statement it can, logs and skips the ones that
fail, and reports a summary — so one bad statement never aborts the whole
schema. Brand-neutral, upstream-friendly.

## In scope
- `backend/src/db/migrate.ts` only.

## Out of scope (YAGNI)
- Process-level resilience (the `unhandledRejection` in `listActive` that exits
  the process) — separate concern, separate potential contrib.
- `scripts/smoke.sh` (does not create users; unaffected).
- `schema.sql` (unchanged; statements stay idempotent `IF NOT EXISTS`).

## Design

Replace the single `pool.query(sql)` with:

1. **`splitStatements(sql): string[]`** — split into top-level statements,
   correctly ignoring `;` that are not statement terminators. Must respect:
   - **`$$` dollar-quoted bodies** (DO blocks / functions): toggle an
     `inDollar` flag on each `$$`; `;` inside is part of the body.
   - **Single-quoted string literals** `'...'`: toggle an `inString` flag on
     `'`; `;` inside is data. Handle Postgres escaped quotes (`''` inside a
     string is a literal quote, not a close) by consuming both chars and
     staying `inString`.
   - Split on `;` only when `inDollar == false && inString == false`.
   - Trim; drop empty fragments.

2. **Per-statement execution** — loop, `await pool.query(stmt)` inside
   try/catch. On error: increment `skipped`, log
   `migrate: statement skipped — <message>\n  → <first 90 chars>…`. Never throw.

3. **Summary** — `console.log('migrate: ok (N statements, M skipped)')`.

Top-level `main().catch` (fatal exit) is preserved for genuinely unexpected
errors (file read, pool init).

### Upstream adaptation
- **Genericize comments** — remove internal `sess.NNNN` references; describe
  the rationale neutrally (single-transaction rollback → partial schema).
- No Polpo naming/branding anywhere in the diff.

## Workflow (contrib doctrine, sess.2818)
1. `git checkout -b contrib/resilient-migration origin/main` (pristine base).
2. Apply the hardened `migrate.ts` (robust splitter: `$$` + `'...'`).
3. `npm run build -w backend` → tsc clean.
4. Write `PR_DRAFT_RESILIENT_MIGRATION.md` (problem / fix / test plan).
5. `git push origin contrib/resilient-migration`.
6. **Mattia opens the PR** (outward-facing act).

## Testing / verification
- **tsc clean** on the contrib branch (gate).
- **Unit-style sanity** (manual, documented in PR): run `npm run db:migrate`
  against a scratch DB containing a deliberate duplicate that breaks one index
  → expect the index statement skipped and all other tables created; output
  `N statements, M skipped` with M ≥ 1.
- **Idempotency**: re-run → `M = 0` skipped on a clean DB.

## Acceptance criteria
- [ ] `contrib/resilient-migration` branched from `origin/main`, no branding in diff.
- [ ] `splitStatements` handles `$$` blocks AND single-quoted strings (incl. `''`).
- [ ] A single failing statement no longer aborts the migration.
- [ ] tsc clean.
- [ ] `PR_DRAFT_RESILIENT_MIGRATION.md` present.
- [ ] Branch pushed; PR left for Mattia to open.
