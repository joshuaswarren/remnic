# Shared orchestrator contracts: one abort classification, capability resolution once, routing agreement, and per-call state views

Status: accepted

## Context
The orchestrator's helpers are shared by every recall surface; small divergences there (a second abort naming scheme, re-reading config mid-operation, a category dir derived independently of the writer, leaked per-session maps) fail in ways that are hard to trace.

## Decision
- All recall aborts go through the shared abort helpers so `name === "AbortError"` classification works uniformly; the "recall aborted" default message is kept for log back-compat, explicit messages unaffected.
- Resolved capabilities and effective state-view flags are resolved ONCE per operation and threaded through (including the publish seam) — never re-read from live config mid-operation. Historical recall pins are recorded at request time so a later annotation cannot discard the predecessor; packet-level final budgeting admits/drops a packet as a unit. Observation-mode direct answers are fire-and-forget so annotation latency never delays the caller.
- Graph subtree routing must match StorageManager.writeMemory routing through the shared category-dir chokepoint, so fallback paths agree with where the file actually lives; otherwise graph edges point at the wrong subtree and expansion silently drops nodes.
- Artifact-enabled recalls overscan, then filter artifact paths and re-apply the recall cap, so artifact results cannot starve the top-N. Pending-review ids are skipped defensively from legacy episode sets. Capability reads use the resolved value, never a re-derivation from config.
- Per-session workspace selections are cleaned up on every early return, even when the feature is off, so the Map cannot accumulate stale entries on long-running gateways. LLM planner shadow mode records what the LLM would have chosen while the heuristic stays effective. Daemon-mode QMD results mirror the relative-path resolution branch for pre-absolutized facts/<date> paths; flat hot-memory identities are canonicalized before merging with native hits; an explicit owning namespace with a relative path never falls through to the default store (absolute paths still fall through).

## Consequences
One classification, one resolution point, and one routing authority per concern; the cost is threading resolved values instead of re-reading config at each use site.

## Origin comments

- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:278` — "// Recall-specific abort helpers. Thin wrappers over the shared"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:279` — "// `abort-error.ts` module so every abort in the codebase shares the"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:280` — "// same `name === "AbortError"` classification contract (`isAbortError`"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:281` — "// works uniformly). We keep the "recall aborted" default message for"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:282` — "// back-compat with call-site logs; callers that pass an explicit"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:283` — "// message (e.g. "extraction aborted (before_extract)") are unaffected."
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:866` — "// Read the resolved capability (issue #1523) — never re-derive from config."
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:926` — "// Overscan when artifacts are enabled, then filter artifact paths before"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:927` — "// re-applying the recall cap to avoid artifact-dominated top-N starvation."
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:1104` — "// #1635 (defensive): skip pending_review ids from legacy episode sets."
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:1172` — "// Pick the subtree that matches the StorageManager.writeMemory routing"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:1173` — "// so fallback paths (used before memoryPathById has seen the fresh"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:1174` — "// write) agree with where the file actually lives. Routing goes through"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:1175` — "// the shared categoryDirName() chokepoint (utils/category-dir.ts) so"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:1176` — "// every category — decisions/, preferences/, reasoning-traces/, ... —"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:1177` — "// resolves to the same dir the writer used; otherwise graph edges point"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:1178` — "// at the wrong subtree and graph expansion silently drops those nodes"
- `packages/remnic-core/src/orchestration/orchestrator-helpers.ts:1179` — "// when readMemoryByPath cannot resolve them (issue #564 PR 3 / #1546)."
- `packages/remnic-core/src/orchestration/qmd-result-resolver.ts:122` — "Daemon-mode results arrive pre-absolutized while the file lives under facts/<date>/ (#2111); mirror relative branch"
- `packages/remnic-core/src/orchestration/qmd-result-resolver.ts:140` — "Canonicalize flat hot-memory identities before merging with native hits (#3194); path-only map"
- `packages/remnic-core/src/orchestration/qmd-result-resolver.ts:310` — "Explicit owning namespace + relative path: do NOT fall through to the default store (#2020); absolute paths still fall"
- `packages/remnic-core/src/orchestration/recall-entry.ts:84` — "Resolve the recall-operation capability gates ONCE... Never re-read migrated flags mid-operation."
- `packages/remnic-core/src/orchestration/recall-entry.ts:239` — "Observation-mode direct-answer tier... fire-and-forget so annotation latency never delays caller."
- `packages/remnic-core/src/orchestration/recall-entry.ts:348` — "#1952 — per-request effective state-view flag... not reread live config."
- `packages/remnic-core/src/orchestration/recall-entry.ts:356` — "#1952 — historical recall pin... annotation must not discard predecessor."
- `packages/remnic-core/src/orchestration/recall-entry.ts:376` — "#2928 — packet-atomic final budgeting... packet admitted/dropped as a unit."
- `packages/remnic-core/src/orchestration/recall-internal-deps.ts:332` — "#1952 — publish seam must not reread live config."
- `packages/remnic-core/src/orchestration/recall-internal.ts:215` — "// #1952 state views: config flag OR per-call override, gated on change intent; computed once for all branches."
- `packages/remnic-core/src/orchestration/recall-internal.ts:511` — "// Clean up workspace selection before early return to prevent Map leaks."
- `packages/remnic-core/src/orchestration/recall-internal.ts:2361` — "// Always clean up per-session workspace selections, even if the feature is off,"
- `packages/remnic-core/src/orchestration/recall-internal.ts:2362` — "// to prevent the Map from accumulating stale entries on long-running gateways."
