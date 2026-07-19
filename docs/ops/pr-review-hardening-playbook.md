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
- `src/storage/**`
- `src/orchestration/**`
- `src/intent.ts`
- `src/memory-cache.ts`
- `src/entity-retrieval.ts`
- `src/config.ts`
- `packages/remnic-core/src/orchestrator.ts`
- `packages/remnic-core/src/storage.ts`
- `packages/remnic-core/src/storage/**`
- `packages/remnic-core/src/orchestration/**`
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
2. `Cursor Bugbot` is not `pending`/`in_progress`/`skipping`.
3. PR has a current-head Cursor signal: either a successful check run, a
   neutral completed Bugbot check run, or an explicit positive Cursor verdict
   comment (`PASS`).
4. No unresolved Cursor-authored review threads remain.

Do not merge on `NEUTRAL` while unresolved Cursor threads remain. The CI AI
review gate treats a neutral completed review-bot check run as current-head
review activity only after the unresolved-thread guard is clean; failed,
skipped, timed-out, or otherwise negative review-bot check runs still block the
gate, and each configured required AI reviewer group must report current-head
activity.

Repository automation:
- `npm run hooks:install` configures git hooks that enforce this gate locally.
- `pre-commit` runs `npm run preflight:quick`
- `pre-push` runs `npm run preflight`
- Local AI pre-push signal: run `npm run review:cursor` before requesting external AI review when the CLI is available.

### Dependabot manifest-only exception

Cursor does not currently produce review activity for Dependabot-authored PRs.
The `ai-reviewers` workflow therefore treats a missing Cursor signal as
satisfied only when every changed file is one of the repository's dependency
manifests: `package.json`, `package-lock.json`, `pnpm-lock.yaml`, or
`requirements.txt`. The exception is fail-closed: an empty diff, a human-authored
PR, any documentation/source/workflow change, any future non-Cursor reviewer
group, or an explicit negative Cursor signal keeps the AI gate blocking.

This exception changes only the structurally unavailable Cursor signal. All
other branch-protection checks remain required, including dependency review,
tests, CodeQL, and the unresolved-review-thread guard. If a Dependabot PR needs
any source or documentation fix, it no longer qualifies; apply the usual
current-head review workflow before merge.

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

## Cross-Reviewer Dedup and Reviewer Lineup (issue #1994, umbrella #1988)

This describes a mechanism that exists, per umbrella decision A (no new
unenforced prose rules).

### What the dedup guard does

`scripts/review-dedup.mjs` (unit-tested against fixtures harvested from the
real #1923 and #1852 duplicate threads) is mirrored inline in
`.github/workflows/review-thread-guard.yml`. After the guard fetches a PR's
review threads it normalizes each finding (badge/markup/feedback footers
stripped), fingerprints the first comment with a deterministic lexical shingle
key, and merges a new thread into an earlier one only when all three hold: same
file, overlapping anchored line range, and fingerprint Jaccard similarity at or
above the committed threshold (`0.5`, measured to separate every real duplicate
pair from all 20 sampled non-duplicate pairs — precision 1.0 on the fixtures).

Precision beats recall by design: a missed duplicate costs one redundant reply;
a false merge can silence a real bug. Nothing is deleted or hidden — a duplicate
inherits its canonical's resolution for the unresolved-thread count, so resolving
the canonical auto-satisfies its duplicates, and a duplicate whose canonical is
still unresolved keeps gating via that canonical.

### Escape hatch (load-bearing)

A single maintainer or agent reply containing `not-a-duplicate` on a merged
thread detaches it back into the round set within one gate cycle — no config
change. Use it the moment a merge looks wrong; a false merge is the failure mode
to fear.

### Shadow vs enforce

The guard step reads `REVIEW_DEDUP_MODE` (default `shadow`). In `shadow` the
unresolved count is byte-identical to pre-#1994 behavior and only the dedup
ledger (threads filed, deduplicated, unique-by-reviewer, canonical links) is
logged, so any false merge is visible before enforcement. In `enforce` the guard
additionally leaves an auditable trail ON each merged thread: an idempotent
gate-authored reply linking the canonical (carrying the detach instructions) and
a PR-level `duplicate-finding` label. It also lets a resolved canonical satisfy
its duplicates for the unresolved count. Flip to `enforce` after the shadow
window once the ledger shows a healthy dedup rate and zero would-have-been-lost
unique findings. The write scopes in the workflow (`pull-requests: write`,
`issues: write`) are exercised only in `enforce`.

### Reviewer lineup

`kilo-code-bot` is retired from the default lineup (it filed ~5% of threads with
no unique catch in the sampled churny PRs). It is not referenced by any required
reviewer group or dispatch workflow; re-adding it later is one revert plus
reinstalling the App. `github-advanced-security`/CodeQL is untouched — it is a
different finding class with near-zero overlap and is never deduplicated.
