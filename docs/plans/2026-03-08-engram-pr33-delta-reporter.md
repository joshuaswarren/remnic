# PR33: Baseline Delta Reporter

## Goal

Add the smallest useful PR-facing report on top of the stored baseline snapshot
contract from PR32:

- one typed report that compares the current eval store against a named stored baseline
- one operator-facing CLI command that emits both JSON and markdown
- one feature flag so the report can land before PR34 wires it into required CI

This slice does not add required-check rollout or benchmark execution.

## Why This Slice Exists

PR32 created durable baseline artifacts, but operators still had to compare
candidate eval stores indirectly. That leaves the release discipline half done:
the baseline exists, but there is no first-class report that turns it into a
reviewable PR signal.

PR33 fixes that gap by making a stored baseline snapshot directly consumable.

## Scope

### Add

- `benchmarkDeltaReporterEnabled`
- typed `EvalBaselineDeltaReport`
- `openclaw engram benchmark-baseline-report --snapshot-id <id>`
- machine-readable regressions/improvements/deltas against a named stored baseline
- markdown output suitable for PR comments or release summaries

### Do Not Add

- new benchmark execution logic
- required GitHub check rollout
- a second comparison engine separate from the existing CI gate comparison logic
- baseline auto-selection heuristics

## Contract

The report:

- reads one named snapshot from `state/evals/baselines`
- resolves the latest completed candidate run per benchmark from the current eval store
- fails when:
  - candidate eval artifacts are invalid
  - a benchmark in the baseline snapshot is missing from the candidate latest-run set
  - pass rate regresses
  - shared metrics regress
- emits:
  - `passed`
  - baseline and candidate roots/metadata
  - missing benchmark ids
  - invalid artifact counts
  - per-benchmark deltas
  - markdown summary

## Verification

1. `npx tsx --test tests/eval-baseline-report.test.ts tests/evals-ci-gate.test.ts tests/cli-benchmark-status.test.ts`
2. `npm run check-types`
3. `npm run check-config-contract`
4. `npm test`
5. `npm run build`

## Follow-on

- PR34: wire named-baseline delta reporting into required CI/docs so memory regressions block merge by default
