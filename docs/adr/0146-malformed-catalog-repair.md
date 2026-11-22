# Malformed catalog rows are repaired by a single-flight, bounded, quarantining rewrite

Status: accepted

A permanently malformed row keeps completion requests owed until the catalog
is rewritten. Naive repair on every malformed read would queue serial lock
waits behind touches and race a concurrent rebuild's lock window.

## Decision

- Only a read that reached the END of the file may trigger repair. The
  repair is gated: at most ONE attempt in flight at a time, plus a short
  backoff after a dropped attempt, so repeated malformed reads never queue
  parallel repairs. The gate starts the attempt as a microtask so `run()`
  returns before any work begins, keeping the guard decision synchronous
  for callers.
- Repair folds the readable rows and rewrites the log without the bad ones,
  best-effort and fail-open like size-triggered compaction. A failed
  attempt (or a held rebuild lock longer than the bounded wait) does not
  consume the backoff budget; a later read retries.
- Dropped rows are quarantined to a hash-named sidecar before the rename, so
  nothing is lost silently and repeated attempts over the same bad rows
  reuse one sidecar instead of piling one per attempt.
- An empty fold from a failed repair read must never replace the catalog.
- Repair respects the rebuild lock and the touch path's held-lock window;
  scheduled rewrites are settled before cleanup so a rewrite never races a
  lock release.

## Consequences

Repair is delayed by contention (bounded waits + backoff) rather than
racing it. Malformed data is preserved in the sidecar for inspection, at
the cost of an extra file per distinct set of bad rows.

## Origin comments
- `packages/remnic-core/src/namespaces/catalog-repair.ts:1` — "/** * Single-flight gate for the malformed-catalog repair (#3298 review), extracted * from catalog.ts so that file sta"
- `packages/remnic-core/src/namespaces/catalog-repair.ts:12` — "/** * Bounds repairs triggered by malformed reads (#3298 review): one attempt in * flight at a time, and a short backo"
- `packages/remnic-core/src/namespaces/catalog-repair.ts:38` — "// Start the attempt as a microtask so run() returns before any of its work"
- `packages/remnic-core/src/namespaces/catalog-repair.ts:39` — "// begins, keeping the guard decision synchronous for every caller."
- `packages/remnic-core/src/namespaces/catalog-repair.ts:57` — "/** * Quarantine sidecar path for the rows a repair drops (#3298 review): named by a * hash of the dropped lines, so r"
- `packages/remnic-core/src/namespaces/catalog.test.ts:35` — "// The rewrite may still be inside its rename/lock window when the last bad row disappears."
- `packages/remnic-core/src/namespaces/catalog.test.ts:551` — "// The read schedules the repair rewrite (#3297); settle it before the finally rm."
- `packages/remnic-core/src/namespaces/catalog.test.ts:645` — "// The read reports quarantined rows as skipped, so the repair rewrite is scheduled (#3297);"
- `packages/remnic-core/src/namespaces/catalog.test.ts:646` — "// let it settle before the finally rm, which would otherwise race its lock release."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4197` — "// The attempt's bounded lock wait runs inside queueCritical, so the holder above"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4198` — "// cannot release until the attempt has settled (dropped): by this point nothing is"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4199` — "// in flight and the cleanup below is safe."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4218` — "// The holder resolves `held` from inside its callback, which runs only once"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4219` — "// the on-disk lock is actually owned: awaiting it proves the lock is held"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4220` — "// before the first read, so the repair can never slip in first."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4226` — "// Real delays remain where the platform clock is the thing under test: the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4227` — "// gate's backoff reads Date.now() and the repair's lock wait really polls."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4230` — "// Past the repair's 5 s lock wait (the attempt drops at ~5.05 s) but still"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4231` — "// inside the 250 ms backoff window that starts at the drop."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4235` — "// Still inside the 250 ms backoff window that began when the attempt dropped:"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4236` — "// this read runs under the still-held lock and must not attempt again."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4243` — "// Past the window, the next malformed read retries and repairs."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4362` — "// Eight reads of the same malformed catalog. Without a single-flight guard each"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4363` — "// schedules its own repair, queueing serial lock waits ahead of touch()."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4397` — "// That attempt was dropped (another process holds the lock), so the backoff"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4398` — "// window is on: further malformed reads must not queue another attempt."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4447` — "// The sidecar write succeeds, the rewrite after it fails. A failed attempt"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4448` — "// does not back off (it holds no lock budget), so a second read retries —"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4449` — "// and the hash-named sidecar must be reused, not duplicated."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4452` — "// Each injected call signals its own completion, so the test awaits the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4453` — "// attempt it scheduled instead of polling the file for a needle that never"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4454` — "// appears. The resolver is registered BEFORE the read that schedules the"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4455` — "// attempt, so the signal can never be missed."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4504` — "// Read #1 (the caller's) succeeds and reports the malformed row; read #2 (the repair's, under"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4505` — "// the lock) throws. An empty fold from the failed read must not replace the catalog."
- `packages/remnic-core/src/namespaces/catalog.test.ts:4539` — "// Another process holds the catalog lock longer than the repair is willing to wait (5 s), so"
- `packages/remnic-core/src/namespaces/catalog.test.ts:4540` — "// the first repair is dropped. The read itself cached the catalog together with its problem."
- `packages/remnic-core/src/namespaces/catalog.ts:517` — "// #3298 review: single-flight + backoff gate for the malformed-catalog repair."
- `packages/remnic-core/src/namespaces/catalog.ts:607` — "// A permanently malformed row keeps every completion request owed until the catalog is"
- `packages/remnic-core/src/namespaces/catalog.ts:608` — "// rewritten, so repair it now: fold the readable rows and rewrite the log without the bad"
- `packages/remnic-core/src/namespaces/catalog.ts:609` — "// ones. Best-effort and fail-open like the size-triggered compaction. Only a read that"
- `packages/remnic-core/src/namespaces/catalog.ts:610` — "// reached the end of the file may trigger it (see CatalogReadHealth.malformed)."
- `packages/remnic-core/src/namespaces/catalog.ts:1371` — "/** * Rewrite the catalog after a read skipped malformed rows (#3297). Same fold-and-rewrite as the * size-triggered "
- `packages/remnic-core/src/namespaces/catalog.ts:1395` — "// Quarantine the rows the rewrite drops before the rename, so nothing is lost"
- `packages/remnic-core/src/namespaces/catalog.ts:1396` — "// silently. Best-effort like the repair itself: a failed sidecar write must not"
- `packages/remnic-core/src/namespaces/catalog.ts:1397` — "// leave a stuck malformed catalog unrepaired."
- `packages/remnic-core/src/namespaces/catalog.ts:1400` — "// Hash-named (#3298 review): repeated attempts over the same bad rows"
- `packages/remnic-core/src/namespaces/catalog.ts:1401` — "// reuse one sidecar instead of piling one per failed attempt."
