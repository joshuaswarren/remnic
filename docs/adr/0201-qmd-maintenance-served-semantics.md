# A QMD maintenance pass serves a completion request only when it fully covered the selection, and plain update() is fail-open

Status: accepted

## Context
Callers that must know a re-index actually ran (e.g. the entity-migration pending marker) previously relied on `requestQmdMaintenanceForTool`, which only arms a debounced timer; a crash would lose the request. A pass may skip namespaces for transient reasons (budget_exhausted, lock_held), permanent reasons (branch_disabled), fail its catalog read, or find a missing collection (swapping to a no-op backend), and plain `update()` resolves silently on gate, backoff, early-exit, or error on every backend.

## Decision
- `update()` on every backend is fail-open: it resolves even when suppressed or errored, and must never be read as proof an update ran. Only variants that report whether an update ran (`updateCompleted`, or QMD's strict variant) may count as served.
- A completion request is served only by a pass that STARTED after the request's rewrite landed, ran the whole namespace selection, and added coverage. Skipped-for-transient-reason namespaces are covered only once they ran in this or an earlier pass of the same request; a permanent-skip namespace (never maintained by this deployment) does not block serving; a failed or truncated catalog read, a missing collection, or a zero-progress pass ends the request unserved (or keeps it waiting on progress) without re-arming forever.
- Requesters needing certainty use the explicit completion API (completion barrier), not the debounced timer.
- Cataloged dynamic namespaces are included in maintenance, each budgeted, lock-protected, and status-recorded independently through the namespace-aware planner.
- The memory-projection scheduled rebuild is interval-throttled, single-flighted, forked off-process with its key never on argv/env, no runtime-secret material passed, freshness checked on disk (adopted into the cheap in-process guard), failure retries on a short separate backoff, the fork timeout floors above a large corpus's legitimate runtime, and any delay larger than the setTimeout overflow ceiling is clamped.

## Consequences
Optimistic callers cannot mistake a suppressed or partial pass for a completed re-index. The cost is pass-status bookkeeping per namespace and requests that stay pending across budget-starved cycles until they converge or end unserved.

## Origin comments

- `packages/remnic-core/src/orchestration/maintenance.test.ts:2890` — "// No projection built yet — the exact issue-#2119 cold state where timeline"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2891` — "// consumers would fall back to full-corpus scans."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2921` — "// Gate off: no projection is created, so the CLI/cron path remains the only"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2922` — "// way to build it."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2932` — "// Seed a projection whose rebuiltAt is one minute ago — inside the 6h"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2933` — "// interval, so a scheduled pass must NOT rebuild it again."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2947` — "// Fresh-within-interval: rebuiltAt is unchanged (no rebuild happened) and no"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2948` — "// backup was written (a rebuild would have archived the prior projection)."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2988` — "// ───────────────────────────────────────────────────────────────────────────"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2989` — "// requestQmdMaintenanceCompletion — #3287 review: a caller that must know the"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2990` — "// re-index actually ran (the entity-migration pending marker) cannot rely on"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2991` — "// requestQmdMaintenanceForTool, which only arms a debounced timer."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:2994` — "/** * Non-namespace scheduler over a scriptable QMD backend. Like QmdClient, plain * `update()` is fail-open: it reso"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3003` — "/** What a plain, fail-open update() does (default: resolve). */"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3005` — "/** What a strict update does; `false` omits the method (a backend that cannot confirm an update). */"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3106` — "// feature-x is skipped as branch_disabled (never maintained): the pass is served for the"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3107` — "// namespaces that ran, but nothing re-indexed feature-x."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3122` — "// Without namespaces there is one corpus; the pass has no per-namespace statuses to match."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3162` — "// QmdClient.update() is fail-open: a min-interval gate or failure backoff"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3163` — "// suppression resolves it silently, and so does an error. Reading that as"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3164` — "// served cleared the marker with no re-index (default non-namespace config)."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3227` — "// Fail-open like every non-QMD backend: resolves even when it returned early or failed."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3290` — "// The orchestrator swaps to a no-op backend when the collection goes missing;"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3291` — "// that pass resolves without indexing anything, so it must not count as served."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3312` — "// Requested while pass 1 is mid-flight: pass 1 started before this request's"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3313` — "// rewrite landed, so only the NEXT pass may serve it."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3364` — "// The configured namespaces still run, but cataloged (dynamic) namespaces were never discovered,"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3365` — "// so the re-index is incomplete and the migration must keep its marker."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3401` — "// A real catalog: the malformed row is skipped (the rest is still maintained), but the pass did"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3402` — "// not see the whole catalog, so the migration must keep its marker."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3433` — "// A cataloged branch namespace is never maintained by default; that is a standing configuration,"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3434` — "// not an unfinished pass, so the ran namespace must still serve the request."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3470` — "// Four configured namespaces, a three-namespace cycle budget: three run, one is skipped"
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3471` — "// as budget_exhausted. That pass did not cover the whole selection, so it must not serve."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3506` — "// The deferred request re-arms a pass; the planner rotates to the namespace that was skipped."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3516` — "// Budget 1 with default and shared: default always ranks first, so shared never gets a turn."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3545` — "// Pass 1 covered default: progress, so the request stays waiting for another pass."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3548` — "// Pass 2 ran default again and added nothing: the request ends unserved and no pass is re-armed."
- `packages/remnic-core/src/orchestration/maintenance.test.ts:3589` — "// shared starved: the pass added coverage once, then a pass adds none and the request ends unserved."
- `packages/remnic-core/src/orchestration/maintenance.ts:138` — "/** Namespaces that ran in passes of the request still waiting for full coverage. */"
- `packages/remnic-core/src/orchestration/maintenance.ts:545` — "// Waiters claimed here are served by THIS pass; later requests wait for the next."
- `packages/remnic-core/src/orchestration/maintenance.ts:549` — "// Set only by the namespace-aware branch; absent means the pass outcome applies to every waiter."
- `packages/remnic-core/src/orchestration/maintenance.ts:554` — "// Include cataloged dynamic namespaces, not just the configured set"
- `packages/remnic-core/src/orchestration/maintenance.ts:555` — "// (NGnei), but run through the namespace-aware maintenance planner so"
- `packages/remnic-core/src/orchestration/maintenance.ts:556` — "// each namespace is budgeted, lock-protected, and status-recorded"
- `packages/remnic-core/src/orchestration/maintenance.ts:557` — "// independently (issue #1500)."
- `packages/remnic-core/src/orchestration/maintenance.ts:626` — "// Namespaces skipped for a TRANSIENT reason (budget_exhausted, lock_held) were not covered"
- `packages/remnic-core/src/orchestration/maintenance.ts:627` — "// by this pass. They are covered once they ran in this or an earlier pass of the same"
- `packages/remnic-core/src/orchestration/maintenance.ts:628` — "// request, so a deployment with more namespaces than the cycle budget still converges."
- `packages/remnic-core/src/orchestration/maintenance.ts:629` — "// Permanent skip reasons describe namespaces this deployment never re-indexes."
- `packages/remnic-core/src/orchestration/maintenance.ts:645` — "// The batch runner drops namespace "*" skips from the statuses, so a failed catalog read"
- `packages/remnic-core/src/orchestration/maintenance.ts:646` — "// is only visible on the plan: cataloged namespaces were never discovered this pass."
- `packages/remnic-core/src/orchestration/maintenance.ts:649` — "// Partial progress keeps the waiters for another pass; no progress, a failure or a failed"
- `packages/remnic-core/src/orchestration/maintenance.ts:650` — "// catalog read ends the request unserved so the next start asks again."
- `packages/remnic-core/src/orchestration/maintenance.ts:654` — "// Plain update() is fail-open on every backend: it resolves when the min-interval gate,"
- `packages/remnic-core/src/orchestration/maintenance.ts:655` — "// failure backoff or an early exit suppressed it, and when it errored. Only the variants"
- `packages/remnic-core/src/orchestration/maintenance.ts:656` — "// that report whether an update ran count (updateCompleted, else QMD's updateStrict)."
- `packages/remnic-core/src/orchestration/projection-rebuild-schedule.ts:1` — "Scheduled rebuild of the root memory projection (#2119); forked child, key never on argv/env, heap postpone"
- `packages/remnic-core/src/orchestration/projection-rebuild-schedule.ts:58` — "Timestamp of most recent FAILURE; short retry backoff separate from the success interval"
- `packages/remnic-core/src/orchestration/projection-rebuild-schedule.ts:77` — "FAILURE_RETRY_BACKOFF_MS — short enough to self-heal, long enough to stay off every maintenance tick"
- `packages/remnic-core/src/orchestration/projection-rebuild-schedule.ts:82` — "FORK_TIMEOUT_MS floor: a large corpus can legitimately run longer than 30 minutes"
- `packages/remnic-core/src/orchestration/projection-rebuild-schedule.ts:87` — "MAX_SETTIMEOUT_MS: a larger delay overflows and fires in 1ms, killing every rebuild"
- `packages/remnic-core/src/orchestration/projection-rebuild-schedule.ts:120` — "Ignore the exit-code argument so a non-zero code is not treated as a scheduler owner"
- `packages/remnic-core/src/orchestration/projection-rebuild-schedule.ts:168` — "Only runtime locators are copied; API keys, tokens, secure-store unlock material are not passed"
- `packages/remnic-core/src/orchestration/projection-rebuild-schedule.ts:321` — "On-disk freshness check: survives restarts and cross-process CLI rebuilds"
- `packages/remnic-core/src/orchestration/projection-rebuild-schedule.ts:325` — "Adopt its timestamp so the next pass short-circuits on the cheap in-process guard"
- `packages/remnic-core/src/orchestration/projection-rebuild-schedule.ts:351` — "Reuse the daemon's live storage so secure-store deployments rebuild through the unlocked instance"
- `packages/remnic-core/src/orchestration/qmd-maintenance-completion.ts:1` — "Callers needing re-index certainty (#3286) cannot rely on the debounced timer; a crash would lose the request"
