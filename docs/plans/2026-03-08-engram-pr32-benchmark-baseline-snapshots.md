# PR32: Benchmark Baseline Snapshots

## Goal

Add the smallest useful baseline-snapshot contract for the evaluation harness:

- a typed snapshot artifact for the latest completed benchmark runs
- operator-facing snapshot capture via CLI
- status visibility into stored baseline snapshots

This slice does not yet add PR-to-baseline reporting or required-check wiring.

## Why This Slice Exists

PR4 added a store-vs-store CI comparator, but Engram still lacks a stable
versioned baseline artifact that can be captured intentionally and reused later.
Without that, later PR delta reporting still depends on ad hoc branch state
instead of a named baseline.

PR32 fixes that by introducing a typed snapshot of the latest completed
benchmark runs under the eval store.

## Scope

### Add

- `benchmarkBaselineSnapshotsEnabled`
- typed `EvalBaselineSnapshot` validation
- `baselines/<snapshotId>.json` storage under the eval root
- `openclaw engram benchmark-baseline-snapshot --snapshot-id <id>`
- `benchmark-status` visibility for baseline snapshot counts and the latest snapshot summary

### Do Not Add

- PR delta reporting
- benchmark execution
- required CI rollout
- shadow-recall changes

## Contract

Each baseline snapshot stores:

- `snapshotId`
- `createdAt`
- `sourceRootDir`
- `benchmarkCount`
- `benchmarks[]`:
  - `benchmarkId`
  - `runId`
  - `completedAt`
  - `gitRef`
  - `passRate`
  - shared metrics
- optional `notes`
- optional `gitRef`

The snapshot captures the latest completed run per benchmark at snapshot time.

## Verification

1. `npx tsx --test tests/eval-baseline-snapshots.test.ts tests/cli-benchmark-status.test.ts tests/evals-benchmark-tools.test.ts tests/evals-shadow-recording.test.ts`
2. `npm run check-types`
3. `npm run check-config-contract`
4. `npm test`
5. `npm run build`

## Follow-on

- PR33: compare candidate eval stores against a named stored baseline snapshot and emit a human-readable delta report
- PR34: wire the delta reporter into required CI/docs so memory regressions block merge by default
