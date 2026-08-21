# Engram PR3: Shadow Recording For Live Recall Decisions

**Status:** implemented  
**Roadmap track:** 1. AMA-Bench-style evaluation harness  
**Flags:** `evalHarnessEnabled`, `evalShadowModeEnabled`

## Goal

Record live recall decisions in a typed, fail-open shadow format so Engram can start measuring real agent trajectories without changing the injected recall output.

## Why This Slice Exists

PR1 created the eval store contract. PR2 made benchmark packs operable. The next missing piece was runtime observation: there was still no durable record of what Engram actually decided during live recall.

Without that, the roadmap could talk about benchmark-first development, but there was no bridge between static benchmark assets and real production behavior.

## Scope

This slice adds:

1. Typed shadow recall record validation.
2. Best-effort live shadow writes during recall when both eval flags are enabled.
3. `benchmark-status` visibility into shadow record counts, invalid shadow files, and the latest recorded shadow summary.
4. Regression coverage proving:
   - shadow recording stays off when shadow mode is disabled
   - shadow recording writes when enabled
   - live recall output remains unchanged

## Non-Goals

This slice does not add:

- benchmark execution
- PR regression comparison gates
- objective-state capture
- alternate ranking logic
- any change to injected recall assembly

## File Plan

- `src/evals.ts`
  - add `EvalShadowRecallRecord`
  - add validation + persistence helpers
  - extend eval status reporting to include shadow counts and latest shadow
- `src/orchestrator.ts`
  - record shadow recall metadata at the end of `recallInternal()`
  - keep the path fail-open on write errors
- `tests/evals-shadow-recording.test.ts`
  - add direct runtime coverage for enabled/disabled behavior
- `tests/cli-benchmark-status.test.ts`
  - extend status expectations to include shadow records
- docs
  - update README, evaluation harness guide, config reference, and changelog

## Verification

1. `npx tsx --test tests/evals-shadow-recording.test.ts tests/cli-benchmark-status.test.ts`
2. `npm run check-types`
3. `npm test`
4. `npm run build`

## Follow-On Slice

PR4 should use these shadow records to compare benchmark deltas across PRs in CI, instead of only reporting local status.
