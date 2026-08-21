# RCA: PR #11 Review Churn (2026-02-21)

## Scope

PR: `#11`  
Title: `Phase 1: recall planner + intent routing + verbatim artifacts`

This RCA explains why the PR required many follow-up commits and how to prevent recurrence.

## What happened

The PR introduced several interrelated changes in one subsystem:

- recall planner mode selection
- intent metadata persistence/routing
- artifact retrieval/filtering
- source-status caching and invalidation

Review feedback repeatedly found second-order issues after each fix.

## Primary Root Causes

1. Subsystem-coupled fixes were applied incrementally without full subsystem re-validation before push.
2. Invariants were implicit, not codified (flag symmetry, zero semantics, cap-after-filter, cache coherence).
3. Cache fixes were initially local-instance or single-condition based, but runtime behavior was multi-instance and concurrent.
4. Planner heuristic changes oscillated between two extremes:
`minimal` too broad vs `minimal` unreachable.

## Recurring Bug Classes Found

1. Zero-value coercion regressions:
- `qmdMaxResults=0` accidentally forced to 1 in minimal mode.
- `verbatimArtifactsMaxRecall=0` accidentally forced to 1.

2. Write/read flag asymmetry:
- intent metadata written even when `intentRoutingEnabled=false`.

3. Filtering/capping order:
- candidate caps applied before source-status filtering caused underfilled artifact injections.

4. Cache coherency gaps:
- stale cache use across status flips
- cross-instance invalidation mismatch
- concurrent write during cache rebuild publishing stale snapshot

5. Reachability regressions:
- planner path where `minimal` became unreachable.

## What would have made PR #11 clean from the start

If done from commit 1:

1. Define invariants explicitly in PR description.
2. Add tests first for:
- mode reachability
- zero-limit behavior
- cache invalidation (cross-instance + concurrent write)
- cap-after-filter behavior
3. Implement the subsystem in one cohesive patch, not serial micro-fixes.
4. Run a mandatory self-review checklist on staged diff before first push.
5. Push only after full verification and invariant confirmation.

## Process Changes Adopted

1. Added hardening playbook:
`docs/ops/pr-review-hardening-playbook.md`

2. Contributor guidance now references mandatory pre-push gate and invariant classes.

3. PR template now includes explicit checks for:
- zero semantics
- flag symmetry
- cache/coherency review
- planner/mode reachability

## Follow-up Improvements (recommended)

1. Add a dedicated retrieval/planner/cache test suite for invariants.
2. Add focused integration tests around recall assembly using fixture memory stores.
3. Add CI job label/path-based “subsystem gate” for files touching:
- `src/orchestrator.ts`
- `src/intent.ts`
- `src/storage.ts`

