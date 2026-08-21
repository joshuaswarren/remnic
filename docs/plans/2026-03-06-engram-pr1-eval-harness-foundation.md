# PR1 Eval Harness Foundation Plan

**PR title target:** `feat: add evaluation harness foundation`

## Goal

Ship the smallest useful benchmark-first slice:

- config and schema flags
- typed benchmark pack format
- typed run-summary format
- status CLI for operators
- README and docs alignment

This PR does **not** change live recall or extraction behavior.

## Why PR1 Starts Here

This matches the roadmap priority order:

1. Evaluation harness and shadow-mode measurement.
2. Objective-state + causal trajectory memory.
3. Trust-zoned memory promotion and poisoning defense.
4. Harmonic retrieval over abstractions plus anchors.
5. Creation-memory, commitments, and recoverability.

Without PR1, every later memory change still lands on intuition.

## Scope

### Code

- `src/evals.ts`
- `src/cli.ts`
- `src/types.ts`
- `src/config.ts`
- `openclaw.plugin.json`

### Tests

- `tests/config-eval-harness.test.ts`
- `tests/cli-benchmark-status.test.ts`

### Docs

- `README.md`
- `docs/config-reference.md`
- `docs/evaluation-harness.md`
- `docs/plans/2026-03-06-engram-agentic-memory-roadmap.md`
- `docs/plans/2026-03-06-engram-pr1-eval-harness-foundation.md`

## Feature Flags

- `evalHarnessEnabled`
- `evalShadowModeEnabled`
- `evalStoreDir`

All default off or inert.

## Contract

### Benchmark manifest

Required:

- `schemaVersion`
- `benchmarkId`
- `title`
- `cases[].id`
- `cases[].prompt`

### Run summary

Required:

- `schemaVersion`
- `runId`
- `benchmarkId`
- `status`
- `startedAt`
- `totalCases`
- `passedCases`
- `failedCases`

## CLI Surface

```bash
openclaw engram benchmark-status
```

The command must:

- work even when `evalHarnessEnabled` is false
- report benchmark pack counts
- report invalid manifests
- summarize latest run
- fail open on missing directories

## Tests Required

1. Config defaults:
   - flags off
   - store dir derived from `memoryDir`
2. Config overrides:
   - explicit flags respected
   - explicit store dir respected
3. CLI empty state:
   - zero counts
   - no crash on missing dirs
4. CLI populated state:
   - valid benchmark counted
   - invalid manifest surfaced
   - latest run summarized

## Verification Gate

Run before pushing:

1. `npx tsx --test tests/config-eval-harness.test.ts tests/cli-benchmark-status.test.ts`
2. `npm run check-types`
3. `npm test`
4. `npm run build`

## Follow-On PRs Unblocked by PR1

- PR2 benchmark pack validator/import tools
- PR3 shadow recording for recall behavior
- PR4 CI benchmark delta gating
- PR5 objective-state memory store
