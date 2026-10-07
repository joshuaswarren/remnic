# Why Stateful PRs Churn

Extracted from `AGENTS.md` (Path B 2026-10-07).

## Why Stateful PRs Churn (Read Before Touching Lifecycle Logic)

PRs in retrieval, session identity, compaction, cache, reset/end-of-session,
namespace/ACL scoping, or flush-plan/extraction lifecycle code
often attract many review rounds for the same structural reason:

1. The subsystem is stateful across multiple entrypoints.
   - A local fix in one hook can break `before_reset`, `session_end`, compaction,
     sparse metadata handling, remembered bindings, provider rebinding, or restart recovery.
2. Reviewers probe different slices of the same state machine.
   - One reviewer may catch provider detection drift.
   - Another may catch lifecycle drain gaps.
   - Another may catch stale-cache or replay behavior.
   These are usually adjacent invariant misses, not unrelated bugs.
3. Comment-by-comment patching makes churn worse.
   - If you only fix the literal review comment, the next review round often finds
     the neighboring invariant you did not model yet.

Required response:

1. Stop and model the full contract first.
2. Write the scenario matrix before changing code.
3. Patch the subsystem coherently once.
4. Add tests for the failure class, not just the reported instance.
5. Run the hardening gate before asking for another review.

Minimum scenario matrix for session/retrieval/cache work — now EXECUTABLE.
These nine rows are the canonical `MATRIX_ROWS` in
`packages/remnic-core/src/testing/lifecycle-matrix.ts`, run against a subsystem
via `runLifecycleMatrix(name, subject)` (issue #1993):

- explicit provider identity
- sparse metadata with remembered binding
- sparse metadata without remembered binding
- provider rebinding
- restart/reload recovery
- compaction flush
- `before_reset`
- `session_end`
- dedupe/replay behavior

Instead of only reasoning about these rows in prose, instantiate them. The two
reference `LifecycleSubject`s —
`packages/remnic-core/src/testing/subjects/extraction-lifecycle.test.ts` (the
extraction / turn-ingestion surface) and
`packages/remnic-core/src/testing/subjects/serialized-write-chain.test.ts`
(the session-toggle write chain) — exercise the REAL orchestrator/store paths
for every row; copy one when hardening a new stateful subsystem. The
`lifecycle-matrix` CI gate (path-triggered via
`scripts/lifecycle-matrix/coverage.json`) fails when a touched lifecycle path
has no registered subject (grandfathered paths warn; the grandfather list only
shrinks). If you cannot explain the behavior for every row — or realize it as a
subject — the PR is not ready for external review.

Minimum scenario matrix for namespace/ACL scoping work (the dominant review
cluster of 2026-06-20..07-04, ~80 findings concentrated in #1506/#1519 — a
semantic, single-subsystem invariant class with no textual signature, so it is
NOT catchable by a `.omp/rules/` stream rule; model it here instead):

- read path and write path resolve through the SAME namespace resolver
  (`resolveWritableNamespace` / scoped-key helpers), never `defaultNamespace`
  on one side
- authenticated principal — never a client-supplied `actor`/namespace — drives
  authorization AND the audit trail
- slot-based lookups reject foreign plugin IDs
- search scope constrained to the session-derived namespace (no cross-tenant
  leakage from an un-namespaced scan)
- catalog `lastWriteAt` / last-seen markers keyed by the sanitized namespace,
  with a reversible encoding (no lossy collision between distinct namespaces)
- profile/scope layering precedence is deterministic and applied identically on
  every entrypoint

Minimum scenario matrix for flush-plan / extraction lifecycle work (#1487 and
kin — also semantic, not stream-rule-able):

- timed-out `before_reset` flush aborts the in-flight extraction before the
  buffer is cleared (late flush cannot clear turns buffered after reset)
- explicit/force flush bypasses the dedupe fingerprint (`skipDedupeCheck`)
- buffer key is propagated through every extraction path (no `"default"`
  fallback clearing the wrong buffer)
- persisted head/marker advances only after a non-empty, fully-persisted batch
- deadline is shared across retries (elapsed time subtracted, not reset)
- `session_end` drains the same way as `before_reset`

