# Resilient per-statement migration

## Problem

`backend/src/db/migrate.ts` runs the whole `schema.sql` as a single
`pool.query(sql)`. In Postgres a multi-statement simple query runs inside one
implicit transaction, so **if any statement fails the entire migration rolls
back** — including statements that already succeeded earlier in the file.

This makes the migration brittle: one statement that can't be applied against
the *current* state of the database aborts everything after it, leaving the
schema partially created. The app then boots and queries a relation that was
never created, and (depending on the supervisor) can enter a restart loop.

Concrete trigger seen in the wild: a unique index intended to enforce an
invariant could not be created because the existing data already violated it.
That single `CREATE UNIQUE INDEX` failure rolled back the whole run, so tables
declared later in `schema.sql` were never created.

## Fix

Apply the schema **statement by statement**, isolating failures:

- `splitStatements(sql)` splits the script into top-level statements, correctly
  ignoring semicolons that are **not** terminators:
  - inside `$$`-dollar-quoted bodies (`DO $$ … $$;` blocks, functions), and
  - inside single-quoted string literals (handling the doubled-`''` escape).
- Each statement runs in its own `pool.query`, wrapped in try/catch. A failing
  statement is logged and skipped; it no longer aborts the rest.
- The run prints a summary: `migrate: ok (N statements, M skipped)`.

`schema.sql` is unchanged — it already uses `IF NOT EXISTS` / idempotent
guards, so re-running is safe and a healthy database reports `0 skipped`.

## Scope

- Touches only `backend/src/db/migrate.ts`.
- No schema changes, no behavioural change on a clean database.

## How to test

```bash
# Clean DB → everything applies, nothing skipped:
npm run db:migrate            # → migrate: ok (N statements, 0 skipped)

# Simulate a statement that can't apply (e.g. pre-insert a row that violates a
# unique index defined in schema.sql), then:
npm run db:migrate            # → that index is "statement skipped — …",
                              #   every other table is still created,
                              #   exit 0, summary shows M ≥ 1 skipped
```

`npm run build -w backend` is clean (tsc).
