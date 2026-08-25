---
"@remnic/core": patch
---

Deterministic daily-journal recap export gains a privacy boundary and a bounded date range (issue #2051): `exportDeterministicRecap` and the new `exportDeterministicRecapRange` / `renderDeterministicJournalRange` omit observation-derived card titles by default (matching the `activity.exportIncludeObservations` policy) while keeping evidence references, and ranges are capped at 366 days with typed validation errors.
