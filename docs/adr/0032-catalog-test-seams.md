# Deterministic concurrency tests use explicit, never-in-production hook seams

Status: accepted

The catalog's race windows (a touch's held-lock critical section, a
rebuild's load->rename window, the lockless scan-to-lock gap, the stale-lock
break re-validation point) are microseconds wide; real timing cannot
reproduce them deterministically.

## Decision

The catalog exposes narrow test-only seams: hooks fired at exact decision
points (after lock acquisition before read->merge->append; after final
re-merge before rename; after scan before lock acquisition; after
stale-lock judgment before re-validation/unlink; after full uncached file
read; after append before cache refresh). Concurrency tests install hooks
here to widen windows and assert interleavings deterministically. Seams are
never set in production code.

## Consequences

Test hooks are part of the catalog's public internal surface and must be
kept in sync when critical sections move; the reward is prove-fail capable
concurrency tests with no sleeps or lucky scheduling.

## Origin comments
- `packages/remnic-core/src/namespaces/catalog.ts:467` — "// Test-only seam (round 7 — NEZkA): fires inside a touch's HELD-lock critical"
- `packages/remnic-core/src/namespaces/catalog.ts:468` — "// section, after the lock is acquired but BEFORE the read→merge→append. A"
- `packages/remnic-core/src/namespaces/catalog.ts:469` — "// deterministic concurrency test installs a hook here to widen the (otherwise"
- `packages/remnic-core/src/namespaces/catalog.ts:470` — "// microscopic) window and prove that a cross-process rebuild CANNOT run its"
- `packages/remnic-core/src/namespaces/catalog.ts:471` — "// load→rename while a touch holds the lock. Never set in production code."
- `packages/remnic-core/src/namespaces/catalog.ts:473` — "// Test-only observation seam: fires only when the JSONL file is fully read."
- `packages/remnic-core/src/namespaces/catalog.ts:474` — "// Cached loads do not invoke it."
- `packages/remnic-core/src/namespaces/catalog.ts:476` — "// Test-only seam: fires after this process appends but before it stats the"
- `packages/remnic-core/src/namespaces/catalog.ts:477` — "// file to refresh the cache identity."
- `packages/remnic-core/src/namespaces/catalog.ts:479` — "// Test-only seam (round 7 — NEZkA): fires inside a mutating rebuild's HELD-lock"
- `packages/remnic-core/src/namespaces/catalog.ts:480` — "// critical section, after the final cross-process re-merge `loadCompacted()` and"
- `packages/remnic-core/src/namespaces/catalog.ts:481` — "// BEFORE the atomic `rename()`. This is the EXACT window in which a check-then-"
- `packages/remnic-core/src/namespaces/catalog.ts:482` — "// append touch (the old bug) would clobber its append. A deterministic test"
- `packages/remnic-core/src/namespaces/catalog.ts:483` — "// installs a hook here to attempt a cross-instance touch in this window and"
- `packages/remnic-core/src/namespaces/catalog.ts:484` — "// assert the held mutex blocks it. Never set in production code."
- `packages/remnic-core/src/namespaces/catalog.ts:486` — "// Test-only seam (NFgCT, codex P2): fires AFTER the lockless disk scan but"
- `packages/remnic-core/src/namespaces/catalog.ts:487` — "// BEFORE the rebuild acquires the cross-process file lock for its final"
- `packages/remnic-core/src/namespaces/catalog.ts:488` — "// load→merge→rename window. A deterministic test installs a hook here to attempt"
- `packages/remnic-core/src/namespaces/catalog.ts:489` — "// a cross-instance touch DURING the scan window and assert it is NOT blocked or"
- `packages/remnic-core/src/namespaces/catalog.ts:490` — "// dropped — proving the scan no longer holds the mutex. Never set in production."
- `packages/remnic-core/src/namespaces/catalog.ts:492` — "// Test-only seam (NG7Bg, codex P2): fires inside `breakStaleRebuildLock` AFTER it"
- `packages/remnic-core/src/namespaces/catalog.ts:493` — "// has judged the lock stale and captured its identity, but BEFORE the final"
- `packages/remnic-core/src/namespaces/catalog.ts:494` — "// re-validation+unlink. A deterministic test installs a hook here to REPLACE the"
- `packages/remnic-core/src/namespaces/catalog.ts:495` — "// lock file (a fresh holder created a new lock in the race window) and assert the"
- `packages/remnic-core/src/namespaces/catalog.ts:496` — "// break is skipped — the replacement's active lock is not deleted. Never set in"
- `packages/remnic-core/src/namespaces/catalog.ts:497` — "// production."
- `packages/remnic-core/src/namespaces/catalog.ts:1299` — "// Test-only seam: widen the held-lock window so a concurrency test can"
- `packages/remnic-core/src/namespaces/catalog.ts:1300` — "// attempt a cross-process rebuild here and assert it is BLOCKED by this"
- `packages/remnic-core/src/namespaces/catalog.ts:1301` — "// held lock (no-op in production)."
- `packages/remnic-core/src/namespaces/catalog.ts:1853` — "// Test-only seam: the SCAN is now complete but the cross-process lock has NOT"
- `packages/remnic-core/src/namespaces/catalog.ts:1854` — "// yet been acquired (NFgCT). A concurrency test attempts a cross-instance touch"
- `packages/remnic-core/src/namespaces/catalog.ts:1855` — "// here and asserts it is NOT blocked/dropped — proving the scan is lockless."
