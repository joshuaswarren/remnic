# Engram PR4: CI Benchmark Delta Gate

**Status:** planned  
**Roadmap track:** 1. AMA-Bench-style evaluation harness  
**Flags:** none for the CI gate itself; it compares eval-store artifacts out of band.

## Goal

Add a small, reviewable CI gate that compares benchmark/eval artifacts between a baseline branch and a candidate branch, and fails when the candidate gets worse.

## Why This Slice Exists

PR1 created the eval contract. PR2 made benchmark packs importable. PR3 started recording live shadow recall decisions. The next missing piece is release discipline: PRs need a machine-checkable way to say "this candidate memory behavior is not worse than baseline."

This slice does **not** add a full benchmark runner. It adds the comparison/gating layer that future benchmark execution slices can feed.

## Scope

1. Typed base-vs-candidate eval-store comparison in `src/evals.ts`
2. CLI wrapper for CI use
3. Regression tests for:
   - improved candidate
   - missing/regressed benchmark
   - invalid candidate artifact
4. Optional GitHub Actions workflow comparing checked-in eval snapshot fixtures between base and candidate branches
5. README/config/docs updates for the new gate

## Non-Goals

- automatic benchmark generation
- benchmark execution in CI
- objective-state capture
- causal trajectory ranking changes

## Comparison Rules

The gate currently fails when:

- candidate eval artifacts are invalid
- baseline eval artifacts are invalid
- a benchmark with a latest completed run in base is missing from candidate
- candidate pass rate drops for a comparable benchmark
- a shared metric regresses

Metric direction:

- higher is better for most metrics
- lower is better for `trustViolationRate`

## Workflow Shape

The GitHub workflow checks out both the candidate branch and the PR base branch, then compares:

- `base/tests/fixtures/eval-ci/store`
- `candidate/tests/fixtures/eval-ci/store`

If the fixture store is absent on either side, the workflow skips cleanly. That keeps the slice safe while giving the repo a real CI integration point now.

## Verification

1. `npx tsx --test tests/evals-ci-gate.test.ts tests/config-eval-harness.test.ts`
2. `npm run check-types`
3. `npm test`
4. `npm run build`
