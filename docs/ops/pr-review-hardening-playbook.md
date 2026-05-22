# PR Review Hardening Playbook

Use this for any PR that touches behavior, performance, safety, or compatibility.

Reference patterns:
`docs/ops/plugin-engineering-patterns.md`

## Why this exists

PR #11 showed a repeated pattern: fixing one review comment introduced or exposed adjacent regressions. This playbook defines a reusable pre-push gate so changes land cleanly with fewer follow-up commits.

## Why PRs Need Many Review Rounds

This usually happens when a stateful subsystem is patched locally instead of
being hardened as a system.

Typical examples in this repo:

- session identity and provider detection
- sparse metadata fallback
- remembered thread/binding reuse
- provider rebinding
- compaction-triggered flushes
- `before_reset` and `session_end`
- cache rebuild and replay/dedupe behavior

What reviewers are actually doing:

1. One review comment exposes the first broken invariant.
2. A follow-up review probes the adjacent path that shares the same state.
3. Another follow-up finds the next uncovered edge.

That is not random reviewer churn. It is evidence that the full state machine
was not modeled before the first fix was pushed.

## First-Pass Hardening Workflow

Use this workflow before requesting another review on any stateful change.

1. Enumerate the owned entrypoints.
   - Example: recall hook, compaction hook, `before_reset`, `session_end`,
     direct flush, restart/load path.
2. Write the scenario matrix.
   - explicit provider identity
   - sparse metadata with remembered binding
   - sparse metadata without remembered binding
   - provider rebinding
   - restart recovery
   - dedupe/replay path
3. Define the invariants per scenario.
   - which buffer key is selected
   - which cache/binding is trusted
   - which flush targets must drain
   - which fallback paths are allowed
4. Fix the subsystem once, not the individual comment.
5. Add tests for the entire failure class.
6. Run the hardening gate.
7. Only then request AI review again.

If you are answering review comments with serial micro-pushes, you are almost
certainly paying for missing matrix coverage.

## Higher-Level Principles (Generalizable)

These apply to any subsystem.

1. Invariants before implementation:
Write down behavioral invariants first (what must never break), then code to them.

2. System over patch:
When comments touch the same subsystem, redesign the subsystem path once instead of stacking local fixes.

3. Configuration is contract:
Flags and numeric limits are part of public API behavior. Treat their semantics (`enabled=false`, `0`) as compatibility guarantees.

4. Cohesion over drift:
Keep core decision logic in one place. Duplicate branches create divergence and recurring review churn.

5. Concurrency realism:
Any cache/state optimization must be designed assuming concurrent reads/writes and multiple instances.

6. Test the failure class, not only the instance:
For each bug, add tests that cover the category of failure so adjacent variants are caught automatically.

## Abstraction Layer: Change Classes

Every review item should be classified before coding:

1. Contract change:
Behavior exposed to users/config/integrations.

2. Control-flow change:
Planner/mode/routing logic that chooses paths.

3. Data lifecycle change:
Write/update/delete/cache/index/status behavior.

4. Operational change:
CI/release/versioning/automation or rollout logic.

5. Documentation change:
User expectations, migration notes, constraints.

For each class touched, require:
- explicit invariant list
- at least one test or verification artifact
- release/upgrade note if external behavior changes

## Abstraction Layer: Blast-Radius Sweep

Before pushing, run this sweep for each touched class:

1. Input edges:
Flags, default values, zero/empty values, disabled paths.

2. Internal edges:
Shared helpers, duplicated branches, cache/index dependencies.

3. Output edges:
User-visible behavior, logs, docs, telemetry, CI gates.

4. Time edges:
Concurrency, stale state, ordering, retries, eventual consistency.

## Mandatory Pre-Push Gate

Run this before every push:

1. `npm run check-types`
2. `npm test`
3. `npm run build`
4. Self-review staged diff for invariant classes below
5. Add/adjust tests for each new invariant touched

## PR Scope Discipline

Default rule: one subsystem group per PR.

If a change spans multiple groups, split it before review whenever possible.
For memory-heavy work, the default split is:

1. schema/surface contract changes
2. storage/serialization/cache changes
3. retrieval/planner/freshness behavior changes

Large mixed-surface PRs are where adjacent invariants get rediscovered one review round at a time.

## Review-Cycle Discipline

1. Sync with `main` before requesting the first serious AI review.
2. Re-scan unresolved comments and group them by subsystem.
3. Apply one cohesive patch per subsystem group.
4. Run verification once.
5. Push once.

Avoid serial micro-pushes that only expose the next nearby invariant.

## High-Risk Path Gate

If you touch any of these files, the hardening suite is mandatory:

- `src/orchestrator.ts`
- `src/storage.ts`
- `src/intent.ts`
- `src/memory-cache.ts`
- `src/entity-retrieval.ts`
- `src/config.ts`
- `packages/remnic-core/src/orchestrator.ts`
- `packages/remnic-core/src/storage.ts`
- `packages/remnic-core/src/intent.ts`
- `packages/remnic-core/src/memory-cache.ts`
- `packages/remnic-core/src/entity-retrieval.ts`
- `packages/remnic-core/src/config.ts`

Command:

1. `npm run test:entity-hardening`

Enforcement:

- local preflight runs the suite automatically when those paths are touched
- CI runs a separate `entity-hardening` job when those paths change

## Mandatory Pre-Merge Cursor Gate

Before merging any PR that uses Cursor/Bugbot review:

1. Required checks are green.
2. `Cursor Bugbot` is not `pending`/`in_progress`/`neutral`/`skipping`.
3. PR has an explicit positive Cursor verdict comment (`PASS`).
4. No unresolved Cursor-authored review threads remain.

Do not merge on `NEUTRAL` without an explicit positive verdict + zero unresolved Cursor threads.
The CI AI review gate enforces the same direction: failed, neutral, skipped,
timed-out, or otherwise non-positive review-bot check runs block the gate, and
each configured required AI reviewer group must report positive activity on the
current head.

Repository automation:
- `npm run hooks:install` configures git hooks that enforce this gate locally.
- `pre-commit` runs `npm run preflight:quick`
- `pre-push` runs `npm run preflight`
- Local AI pre-push signal: run `npm run review:cursor` before requesting external AI review when the CLI is available.

## Stale AI Review Recovery

If `Cursor Bugbot` is still pending after all other checks are green:

1. Verify the current head SHA.
2. Retrigger once.
3. Stop pushing while waiting for the fresh verdict unless a real defect is found.

Do not merge based on an older PASS that targeted a previous head.

## Invariant Classes (must be checked)

1. Flag symmetry:
`enabled=false` must disable both write-time and read-time effects.

2. Zero semantics:
A configured `0` must remain `0` (never coerced to `1`).

3. Cap-after-filter:
Do not apply top-K before validity/status filtering when the filtered set is what users consume.

4. Cache coherence:
Cache invalidation must work:
- across instances
- across status transitions
- under concurrent writes/rebuilds

5. Single-path logic:
Avoid duplicated filtering logic branches that can drift.

6. Reachability:
Every documented mode/flag path must be reachable in runtime logic and covered by tests.

7. Fallback parity:
Primary and fallback retrieval paths must apply equivalent policy constraints.

8. Recall pipeline ordering:
Retrieve headroom -> filter -> rerank/boost -> cap -> format.
Never apply final cap before policy/path/status filtering.

9. Heuristic robustness:
Regex/heuristic classifiers must support common language variants and avoid malformed stems.

10. TTL correctness:
Cache `loadedAt` timestamps must represent completion time of cache rebuild, not start time.

## v8.15 Behavior-Loop Hardening Checklist

Use this checklist for PRs that touch behavior-loop auto-tuning, runtime policy application, or policy observability paths.

1. Artifact isolation preserved:
- Generic QMD/embedding recall paths must continue excluding `artifacts/`.
- Artifact recall must stay isolated to dedicated verbatim artifact paths.

2. Cap-after-filter preserved:
- Retrieval order must remain `headroom -> filter -> rerank/boost -> cap -> format`.
- Any top-K limits exposed to users must be applied after policy/path/status filtering.

3. Config contract preserved (`enabled=false` and `0` limits):
- `behaviorLoopAutoTuneEnabled=false` remains a hard disable (no learner apply side effects).
- Numeric `0` values remain explicit hard caps/disables and are never coerced to non-zero defaults.

4. Planner mode semantics unchanged:
- `no_recall`, `minimal`, `full`, and `graph_mode` must remain reachable.
- `no_recall` must still gate all recall fallbacks.
- `minimal` mode recall budgets must remain bounded.

5. Policy version parity:
- Policy version shown by CLI (`policy-status` / `policy-diff`) must match policy version emitted in recall telemetry for the same effective runtime policy values.

## v8.16 Compounding Artifact Hardening Checklist

Use this checklist for PRs that touch weekly compounding reports, rubrics, or promotion-candidate synthesis.

1. Provenance integrity:
- Weekly pattern and rubric outputs must preserve source provenance (feedback/action source + line references where available).
- Provenance formatting should stay deterministic for stable diffs.

2. Outcome summary consistency:
- Any displayed action outcome score/weight must be explainable from visible counts.
- If score denominator includes `unknown`, rendered summaries must include `unknown` count.

3. Advisory-only promotion contract:
- Promotion candidate sections must remain explicitly advisory.
- Compounding reports/tools must not auto-write promotion candidates into shared memory.

4. Duplicate parsing drift prevention:
- Shared telemetry sources (for example memory-action JSONL) should be parsed through one helper path per run to avoid divergence between summary sections.

5. Gate behavior:
- Optional compounding sections must remain behind explicit config gates.
- Disabled path must preserve baseline weekly output behavior (fail-open and no hidden side effects).

## Required Tests for These Changes

When relevant, add tests for:

- planner mode reachability (`no_recall`, `minimal`, `full`, `graph_mode`)
- zero-limit behavior (`qmdMaxResults=0`, `verbatimArtifactsMaxRecall=0`)
- cache invalidation across instances
- concurrent write during cache rebuild
- post-filter cap fill behavior
- fallback path policy parity
- artifact path isolation from generic memory recall
- intent variant coverage (`decision`, `decided`, `chose`, `chosen`, etc.)

## PR Batch Strategy

If multiple comments touch the same subsystem:

1. Fix all related issues in one cohesive patch set.
2. Re-run full verification once.
3. Push once.

Avoid serial micro-fixes unless comments are independent.
