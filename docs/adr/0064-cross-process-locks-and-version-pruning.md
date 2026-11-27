# Destructive writes revalidate lock ownership immediately before landing, and version-history pruning only counts committed snapshots

Status: accepted

## Context

File locks use mtime heartbeats, so a CPU-bound or paused section can outlive the stale window and a peer may break its lock mid-section. Snapshot pruning runs concurrently with merges; counting staged-but-uncommitted entries over-prunes, and crash windows can strand pending entries or dangling snapshot references.

## Decision

Every destructive write revalidates lock ownership immediately before it lands and aborts on loss (the GraphWriteLockSection pattern); the mtime heartbeat being a timer is never treated as proof of ownership. Lock tests use real wall-clock and await the real "holder owns the lock file" signal rather than guessed durations; a held lock with budget exhaustion fails loudly instead of falling back to unlocked behavior (fail closed, file untouched).

Version pruning counts only COMMITTED snapshots: staging happens before compare-and-swap, but a pending writer's entry is excluded from another writer's prune accounting, an aborted writer's staged entry leaves without taking a committed rollback point, and a finalization whose merge already committed but whose prune failed transiently must be reconciled by the NEXT successful finalization so history stays bounded by the cap. The reconciliation marker is append-only and idempotent-tolerant: reading it must not throw on stale/unknown ids, must not clear a still-pending concurrent writer's entry, and must never remove extra committed snapshots (only a writer's OWN failed finalization records its id).

Cleanup ordering is publish-before-cleanup: an aborted remove, cap prune, or fresh stage never unlinks snapshot state before the manifest publication that records it; after any publication failure every manifest entry's snapshot stays readable and the manifest either reflects the mutation or does not — never half.

The memory lifecycle ledger reads are bounded and canonical: rank by (memoryId, timestamp, eventType) and keep the last N; unknown-but-structurally-valid eventTypes take a defined sort position; timestamp order is not assumed (late backfills exist). Compaction of the encrypted ledger decrypts through the buffer path, preserves raw bytes of rows the fail-open parser drops (never a whole-buffer UTF-8 decode above the cap), and appends serialize against the compaction rewrite under the shared lock with a budget that fits a large-ledger rewrite; spilled pending appends are claimed atomically (rename as the claim, crash-safe on the read-only-dir and post-claim-crash paths). Lifecycle event projection falls back to the ledger when no projection store exists.

## Consequences

Revalidation points add a failure mode to every destructive write; pending-version entries temporarily consume space beyond the cap until a later finalization reconciles them.

## Origin comments

- `packages/remnic-core/src/storage-append-profile.test.ts:17` — "// Hold the FIRST write open while the second append runs a full RMW. Under"
- `packages/remnic-core/src/storage-append-profile.test.ts:18` — "// a shared unlocked RMW both reads see the same (missing) profile and the"
- `packages/remnic-core/src/storage-append-profile.test.ts:19` — "// second write silently drops the first task's bullet."
- `packages/remnic-core/src/storage-append-profile.test.ts:24` — "// SAFETY: the test drives only readProfile/writeProfile on the real manager;"
- `packages/remnic-core/src/storage-append-profile.test.ts:25` — "// instance overrides keep the RMW interception local to this test."
- `packages/remnic-core/src/storage-append-profile.test.ts:67` — "// The peer must NOT fall back to an unlocked RMW: fail closed, file untouched."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:149` — "// Two concurrent merges stage their pre-merge snapshots (deferPrune)"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:150` — "// before either compare-and-swap commits. Writer A commits and finalizes"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:151` — "// the prune while writer B is still pending: counting B's uncommitted"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:152` — "// snapshot would remove one MORE valid rollback point than the cap"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:153` — "// requires, and B's later abort would leave history short of the cap."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:200` — "// Writer B's attempt then aborts (lost compare-and-swap): its entry"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:201` — "// leaves history without taking any committed rollback point with it."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:214` — "// A finalization whose merge had ALREADY committed can fail transiently"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:215` — "// (manifest lock timeout, unreadable manifest). Pre-fix, the catch only"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:216` — "// logged: the staged entry stayed `pending` forever, pruneExcessVersions"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:217` — "// excludes pending entries, and every such failure stranded one"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:218` — "// unprunable snapshot beyond the cap. The next successful finalization"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:219` — "// must reconcile the stranded entry so the prune bounds history again."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:234` — "// Merge 1: stage the rollback snapshot, commit the merged body, then the"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:235` — "// finalizing prune FAILS — here via a transiently unreadable manifest"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:236` — "// (the lock-timeout production shape: pruneVersions throws, the catch is"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:237` — "// best-effort, the entry stays pending)."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:267` — "// Merge 2: stage, commit, and finalize SUCCESSFULLY. It must clear its"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:268` — "// own flag AND reconcile merge 1's stranded entry, so the committed set"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:269` — "// {v1, v2, v3, staged1, staged2} prunes back to the cap."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:304` — "// The marker is append-only and never rewritten, so it accumulates ids"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:305` — "// whose entry was later removed (aborted writer's id reused path) or"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:306` — "// already cleared by an earlier reconciliation. Reading them must neither"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:307` — "// throw, clear a still-pending concurrent writer's entry, nor remove any"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:308` — "// extra committed snapshot."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:322` — "// A still-pending concurrent writer plus stale marker ids: one for an"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:323` — "// entry that does not exist (999) and one for an already-committed"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:324` — "// entry (\"1\"). Neither resolves to a clearable pending entry, and the"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:325` — "// still-pending writer's entry has NO marker record — only a writer's"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:326` — "// OWN failed finalization can record its id — so reconciliation must"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:327` — "// leave it pending and touch nothing else."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:360` — "// ── Final round (A): publish-before-cleanup ordering ────────────────────────"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:361` — "// An aborted merge's removeVersion, a cap prune, and a fresh stage all used to"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:362` — "// unlink/drop snapshot state BEFORE the manifest publication that records it."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:363` — "// When the publication then failed (transient I/O, full disk), the on-disk"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:364` — "// manifest kept referencing a now-missing snapshot — a dangling reference that"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:365` — "// getVersion/revert fail on and prune never cleans. The invariant under test:"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:366` — "// after ANY publication failure, every manifest entry's snapshot stays"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:367` — "// readable, and the manifest either reflects the mutation or does not — never"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:368` — "// half of it."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:394` — "// Transient publication failure: the manifest file itself is read-only,"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:395` — "// so a non-atomic overwrite fails while snapshot unlinks (directory"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:396` — "// permission) still succeed — the exact pre-fix dangling shape."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:486` — "// ── Final round (B): ownership revalidation before destructive writes ───────"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:487` — "// The lock's mtime heartbeat is a timer; a section paused past the 30s stale"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:488` — "// window (CPU-bound pause, suspended process) cannot heartbeat, so a peer can"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:489` — "// break the lock and commit its own mutation. Every destructive write must"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:490` — "// revalidate ownership immediately before it lands and abort on loss — the"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:491` — "// same pattern the graph JSONL lock adopted (GraphWriteLockSection)."
- `packages/remnic-core/src/storage-contract/versioning.test.ts:604` — "// The fake peer never releases its lock; clear it so the stage below"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:605` — "// acquires fresh and the SECOND break lands mid-section, not as a busy"
- `packages/remnic-core/src/storage-contract/versioning.test.ts:606` — "// 10s acquire timeout against a live-looking peer."
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:711` — "// PR #2016: when saveMergingWithDisk cannot acquire the cross-process lock in // time, it used to resolve \"successfully"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:866` — "// PR #2016 (startup hash-index rebuild race): ensureFactHashIndexAuthoritative // used to run its corpus scan and publi"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:999` — "// PR #2016 findings 1-2 + 3: when the authoritative rebuild lock cannot be // acquired, hasFactContentHash()/getAuthori"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:1163` — "// Test-only access to storage/index internals: the shape is structurally // known and a runtime check would be meaningl"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:136` — "The bounded read ranks by the canonical comparator (memoryId, timestamp, eventType), then keeps the last 2 — identical"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:163` — "Structurally valid row whose eventType is NOT in the handled sort table. readAll admits any string eventType, so the b"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:215` — "Target events appended in strictly increasing timestamp order — the production invariant that makes ring-of-last-N-the"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:233` — "Target rows appended in this order; the LAST-appended row carries the OLDEST timestamp (a late backfill). The old appe"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:300` — "The compaction read must decrypt the same rows the general capped read returns — but through the buffer path, so it al"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:371` — "Simulate a compaction rewrite holding the shared lock while the append contends for it. The append must WAIT for the h"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:429` — "A fresh (non-stale) foreign lock held for the whole test so acquisition times out within the tiny budget and never sta"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:456` — "withHeldFileLock's default acquisition budget is 5s; a compaction rewrite of a large ledger can legitimately hold the "
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:470` — "Plaintext pending IO for the access-layer tests (the StorageManager integration test below exercises the encrypted-at-"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:530` — "Hold the ledger lock so the append cannot acquire it and must spill — mirroring a compaction rewrite holding the lock "
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:537` — "Capture exactly what a concurrent fold-under-lock would enumerate + read (the fold uses listContainedSpillFiles + a la"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:747` — "Pre-seed an encrypted spill file exactly as a lock-timed-out append leaves it: encrypted at its own path-bound AAD."
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:834` — "A read-only spill dir lets the read succeed but blocks the rename CLAIM (`q.jsonl` → `q.jsonl.claimed`, which needs di"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:877` — "Simulate a drain that CLAIMED a spill (renamed q.jsonl → q.jsonl.claimed) and then the process CRASHED before committi"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:983` — "The preserve+merge+serialize inside the lock is CPU-bound and blocks the timer heartbeat, so within the 30s stale wind"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:1008` — "Simulate a peer stale-breaking our lock DURING the under-lock preserve read: overwrite the lock content with a foreign"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:1058` — "Seed an encrypted-at-rest ledger that mixes valid rows with rows the fail-open parser silently drops: a non-JSON line,"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:1112` — "Store is UNLOCKED (key present) but the encrypt-on-write policy is paused. A compaction of an already-encrypted ledger"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:1156` — "Regression for the P2 raw-backup thread: the secure-store backup path once read the decrypted ledger via `Buffer.toStr"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:1174` — "A ~2MB encrypted ledger: two valid rows plus many non-JSON garbage lines the fail-open parser drops. The active rewrit"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:1187` — "Trap ONLY a whole-buffer utf8 decode larger than the cap. Ranged decodes (the per-line ledger reader) produce small st"
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:1252` — "Four ~400KB spills. Bounded 1MB batches commit two per append, so with a LAZY per-batch read the second batch's reads "
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:1293` — "A single malformed row far larger than the per-row decode cap (64MB) with no newline: decoding it whole as one string "
- `packages/remnic-core/src/storage-memory-lifecycle-ledger.test.ts:1324` — "No projection sqlite exists in this temp dir, so both calls take the ledger fallback — the exact issue-#2119 regressio"
- `packages/remnic-core/src/storage-update-meta.test.ts:9` — "Real wall-clock is deliberate here: the lock helper's acquire budget and heartbeat polling run on platform timers, and"
- `packages/remnic-core/src/storage-update-meta.test.ts:19` — "Await the real signal \"holder owns the lock file\", not a guessed duration."
- `packages/remnic-core/src/storage-update-meta.test.ts:54` — "A live external holder (a different owner id through the same helper the out-of-process drain workers use) keeps the l"
- `packages/remnic-core/src/storage.ts:5600` — "// Lock-serialized against compaction; on lock-budget exhaustion the event"
- `packages/remnic-core/src/storage.ts:5678` — "// Serialize the whole read→dedup→append→cache-commit transaction per"
- `packages/remnic-core/src/storage.ts:5731` — "// Collect newly-seen keys in a SEPARATE set — never mutate `existingKeys`"
- `packages/remnic-core/src/storage.ts:5759` — "// Durable now: fold the new keys into the set (in place, O(new keys) — keeps"
