---
"@remnic/core": patch
Stability: stable
---

Stability: stable

Register the `memory-maintenance` lifecycle-matrix subject covering
`maintenance/forget.ts`, `maintenance/memory-governance-cron.ts`, and
`maintenance/tier-stats.ts`, and map the three paths in
`lifecycle-matrix/coverage.json` so edits to them stop failing the
coverage gate (#3642).
