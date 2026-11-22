---
"@remnic/core": patch
Stability: stable
---

The Memory Worth recall filter's shipped default is now pinned by a test instead of a stale note. `recallMemoryWorthFilterEnabled` resolves to `true`, every published manifest advertises that same default (the OpenClaw SDK materializes the schema default into `api.pluginConfig` before `parseConfig` runs), and the precision bench still shows the filter winning: precision@5 0.00 to 0.60 over 50 seeded cases, no regressions. The "default false until the benchmark" notes in `types.ts` and `memory-worth-filter.ts` are corrected. Operators can still opt out with `recallMemoryWorthFilterEnabled=false`.
