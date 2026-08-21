---
"@remnic/core": minor
---

test(lifecycle): executable lifecycle scenario-matrix harness (#1993)

Turn the AGENTS.md session/retrieval/cache scenario matrix into an executable,
path-triggered required check (umbrella #1988 phase 5).

- New `packages/remnic-core/src/testing/lifecycle-matrix.ts`: `MATRIX_ROWS`
  (the nine canonical AGENTS.md rows, typed) + `runLifecycleMatrix(name, subject)`
  registering one named test per row over a `LifecycleSubject`. Test-support
  only — lives under `src/testing/`, excluded from the runtime bundle and
  `exports`. Fixtures (`orchestrator-lite.ts`) are extracted from the
  entity-hardening characterization suite, not reinvented.
- Two reference subjects exercising REAL paths for every row:
  `subjects/extraction-lifecycle.test.ts` (turn-ingestion/extraction, the #1852
  surface — its `before_reset` row is falsified by inverting the abort wiring)
  and `subjects/serialized-write-chain.test.ts` (the session-toggle write chain).
- `scripts/lifecycle-matrix/coverage.json` + `check-coverage.mjs`: a
  path-glob → subject mapping and a CI gate (new `lifecycle-matrix` job in
  `ci.yml`) that fails when a touched lifecycle path has no registered subject;
  grandfathered paths warn (ratchet: shrink-only, decision C). Reuses
  `scripts/effective-diff.mjs`.
- AGENTS.md matrix section now points at the harness; the duplicate
  "Why Review Churn Happens" prose matrix collapses to a pointer (decision A —
  no new prose-only rules).

Production behavior is unchanged.
