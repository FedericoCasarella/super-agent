<!-- Keep PRs small and single-purpose. One change, one reason. -->

## What & why

<!-- What does this change and what problem does it solve? -->

## Type of change

- [ ] 🐛 Bug fix
- [ ] ✨ Feature
- [ ] 🔌 New connector
- [ ] 📝 Docs
- [ ] ♻️ Refactor / chore

## Checklist

- [ ] `cd backend && npx tsc --noEmit` is green
- [ ] `cd frontend && npx tsc --noEmit` is green
- [ ] No secrets committed (connector credentials live in the DB)
- [ ] Migration is idempotent if `schema.sql` changed (`CREATE … IF NOT EXISTS`)
- [ ] Scoped to a single concern

## Notes for reviewers

<!-- Anything that needs context, or follow-ups intentionally left out. -->
