# The content-hash dedup index is deferred, lock-reconciled, fact-partitioned, and treated as a cache whose authority is always re-derived from disk

Status: accepted

## Context

The fact-hash dedup index grows with the corpus; rewriting it per write is O(corpus) and cross-process writers race its read-modify-write windows. A wrong dedup answer silently suppresses real writes, and the opposite error re-creates duplicates — both are data integrity failures.

## Decision

Index persistence is deferred (batched save), and every durable publish of fact-hashes.txt happens under the per-file advisory lock with a read-UNION-write reconcile: a save merges its snapshot with what is on disk instead of reassigning, so a concurrent in-process or peer-process addition is never dropped. Removal-aware reconciles subtract removed hashes so a removal never resurrects, and a no-op run must not re-read+rewrite the file. When saveMergingWithDisk cannot acquire the lock, the write defers to an unref'd background retry (and a direct write drains the retry inline before returning) instead of resolving "successfully" with the hash unpersisted.

Fact-only membership (hasFactContentHash) lives on a fact-only partition of the shared index: a non-fact body must never satisfy a fact-hash check, or unrelated decisions/preferences would suppress real fact candidates for callers that trust a hit. Only active (un-tombstone-blocked) facts enter the index (non-resurrection chokepoint), indexed from the caller's raw contentHashSource. Partition entries are dropped on supersede/rewrite in lockstep, and the rebuild is cold-aware (covers cold/ targets).

Index authority is NOT permanent: a peer process can advance it, so the authoritative rebuild always runs from the durable corpus on first use per process (hot and cold tiers together), under the lock, with bounded retries so transient lock contention degrades to a documented answer rather than a wrong one.

Appends to the encrypted-classified files use header-only sniffing (read at most MAGIC_HEADER_SIZE bytes), cached by (size, mtime) file identity and re-validated so a plaintext→encrypted flip between managers is detected and the stale-side append refuses rather than corrupting ciphertext; on a dedup-cache hit the key set is not mutated until the append is durable, and per-instance mutexes serialize concurrent appends so an incomplete set is never committed under the final file identity. The behavior-signals ledger keeps its dedup key set in memory validated by file identity instead of re-parsing the unbounded JSONL per append.

## Consequences

Deferred retries mean a crash can leave a hash unpersisted until the next drain; header-sniff identity validation trusts (size, mtime), same caveat as the corpus caches.

## Origin comments

- `packages/remnic-core/src/storage-append-header-sniff.test.ts:10` — "// Issue #1909 (Part A): the plaintext secure-append path must classify a file"
- `packages/remnic-core/src/storage-append-header-sniff.test.ts:11` — "// as encrypted by reading ONLY the fixed-size magic header, never the whole"
- `packages/remnic-core/src/storage-append-header-sniff.test.ts:12` — "// file (a lifecycle ledger can grow to hundreds of MB on a large corpus), and"
- `packages/remnic-core/src/storage-append-header-sniff.test.ts:13` — "// it must cache the classification so subsequent appends do NO reclassification"
- `packages/remnic-core/src/storage-append-header-sniff.test.ts:14` — "// read at all."
- `packages/remnic-core/src/storage-append-header-sniff.test.ts:27` — "/** * Spy the private whole-file read used by the encrypted-append branch so a test * can assert the plaintext"
- `packages/remnic-core/src/storage-append-header-sniff.test.ts:173` — "// A long-lived manager caches plaintext for an append target; a SECOND manager"
- `packages/remnic-core/src/storage-append-header-sniff.test.ts:174` — "// then encrypts that file (whole-file rewrite). The first manager's next append"
- `packages/remnic-core/src/storage-append-header-sniff.test.ts:175` — "// must detect the flip via (size, mtime) identity re-validation and NOT append"
- `packages/remnic-core/src/storage-append-header-sniff.test.ts:176` — "// raw bytes into the encrypted body (data corruption)."
- `packages/remnic-core/src/storage-append-header-sniff.test.ts:187` — "// A's next append must detect the flip and refuse (A has no key) rather than"
- `packages/remnic-core/src/storage-append-header-sniff.test.ts:188` — "// corrupt the ciphertext with a raw plaintext append."
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:11` — "// Issue #1909 (Part C): appendBehaviorSignals used to re-read + JSON.parse the"
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:12` — "// whole (unbounded) behavior-signals.jsonl on EVERY append to rebuild a dedup"
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:13` — "// key set. It now keeps the key set in memory, validated by (size, mtime) file"
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:14` — "// identity; a foreign write forces a reload, matching the catalog cache pattern."
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:150` — "// A fresh, locked, secure-required store must not silently read plaintext —"
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:151` — "// reading the encrypted ledger to rebuild the dedup set throws."
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:163` — "// Issue #1909 review finding 4 (HIGH data-loss): on a cache hit the dedup set"
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:164` — "// must NOT be mutated before the append is durable. Otherwise a failed append"
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:165` — "// (unchanged size/mtime) leaves the next call cache-hitting a poisoned set and"
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:166` — "// silently dropping the events forever."
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:214` — "// Issue #1909 review round 3: without a per-instance mutex, two concurrent"
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:215` — "// appends each snapshot their own dedup set before the writes serialize; the"
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:216` — "// later completion commits an INCOMPLETE set under the final file identity, so"
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:217` — "// a subsequent call cache-hits a set missing the first batch and writes"
- `packages/remnic-core/src/storage-behavior-signals-cache.test.ts:218` — "// duplicate signals."
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:70` — "// writeMemory only registers facts on the write hot path, but the"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:71` — "// authoritative corpus rebuild (first fact-hash use) indexes EVERY active"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:72` — "// registered category (PR #2016) so a restart never re-creates an identical"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:73` — "// decision/preference/commitment. The SHARED content-hash index is therefore"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:74` — "// category-agnostic — probe it directly."
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:81` — "// hasFactContentHash, however, is fact-ONLY (PR #2016): a non-fact body must"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:82` — "// NOT satisfy a fact-hash check, or an unrelated decision/preference/note"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:83` — "// would suppress a real fact candidate for direct consumers (wearable/native"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:84` — "// writers, explicit-capture) that trust a hit before their own category or"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:85` — "// source confirmation."
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:178` — "// Supersede: the frontmatter rewrite runs syncFactHashIndexAfterRewrite →"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:179` — "// removeFactContentHashesForMemories, which must drop BOTH the shared hash"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:180` — "// and the fact-only partition. A stale partition entry is the PR #2016"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:181` — "// stale-true bug class: wearable / explicit-capture / promotion callers"
- `packages/remnic-core/src/storage-contract/content-hash.test.ts:182` — "// would skip a valid re-write."
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:22` — "// Issue #1909 (Part B): writeMemory(\"fact\") used to rewrite the whole // fact-hash index (which grows with corpus size)"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:281` — "// PR #2016 thread SDyCk: a direct (non-deferred) fact write used to publish // fact-hashes.txt with the unlocked whole-"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:311` — "// The rebuild used to build a fresh fact-only set and publish it with a // reassignment, dropping any concurrent in-pro"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:358` — "// The plain overwrite save() materializes its body, then awaits disk. A // same-process add() that lands during that aw"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:391` — "// Drive the deferred reconcile retry inline. On the buggy source save() // cleared dirty and armed nothing, so this is "
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:410` — "// Issue #1909 review finding 2: promotion writes (profile/shared) do NOT // register with the orchestrator's batch save"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:528` — "// Review round 6 finding 2: two independent index instances (two processes) // that both snapshot an empty file must no"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:553` — "// Review round 7 finding 2: the per-file advisory lock serializes the // read-union→write window across truly concurren"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:577` — "// Review round 7/8: a removal must never resurrect. The reconciling save is // removal-aware — it subtracts removed has"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:606` — "// Review round 8 thread 3: removal and append batches serialize under the same // per-file lock and both reconcile with"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:640` — "// Review round 7 finding 3: a no-fact/deduped run must not re-read+rewrite the // whole fact-hashes.txt. An unmutated i"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:669` — "// Issue #1909 review round 14: the markerless authoritative rebuild // (ensureFactHashIndexAuthoritative) used to read "
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:1140` — "// PR #2016 thread SDzOP: the storage-owned removal // (removeFactContentHashesForMemories) and the approval re-add // ("
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:1219` — "// PR #2016 thread SD7Tj: the reconcile publish() snapshots this.added at its // start, then read+rewrites fact-hashes.t"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:1260` — "// The mid-save addition must survive in-memory (old code wiped it via // `this.hashes = merged` + `this.added.clear()`)"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:1264` — "// ...and it must still be durably persistable — old code set dirty=false so // the drain below would be a no-op and the"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:1277` — "// PR #2016 thread SD7Tk: a direct (non-deferred) writeMemory(\"fact\") awaited // saveMergingWithDisk, which on a lock ti"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:1300` — "// The direct write must have drained the deferred retry inline before // returning. Under the old code writeMemory awai"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:1336` — "// B directly re-adds the same content. Pre-fix this was a no-op: the local // snapshot already held the hash, so add() "
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:1354` — "// Parallel to thread SD-nG for add(): the reactivation path // (StorageManager.addActiveFactContentHash) re-registers a"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:1382` — "// B re-registers the same hash via addByHash (the reactivation path). Pre-fix // a no-op; fixed, it records the durable"
- `packages/remnic-core/src/storage-fact-hash-index-defer.test.ts:1398` — "// restoreFactHashAfterApproval -> addActiveFactContentHash used to publish the // reintroduced hash with a bare saveMer"
- `packages/remnic-core/src/storage.ts:1892` — "/** * Fact-ONLY hash membership (PR #2016 / issue #2474) lives on the shared * `ContentHashIndex` fact-only partition "
- `packages/remnic-core/src/storage.ts:2995` — "// Encrypted-store branch (issue #1909, known limitation): the sealed format"
- `packages/remnic-core/src/storage.ts:3305` — "// PR #2016 review: authority is NOT permanent. A peer process can advance"
- `packages/remnic-core/src/storage.ts:3324` — "// ALWAYS rebuild the index from the durable corpus on first use per"
- `packages/remnic-core/src/storage.ts:3333` — "// PR #2016 (findings 1-2): bounded-retry the LOCKED rebuild so transient"
- `packages/remnic-core/src/storage.ts:3374` — "// Fact-ONLY membership is rebuilt in lockstep (PR #2016 / issue #2474):"
- `packages/remnic-core/src/storage.ts:3382` — "// #1909 review round 14: index the HOT and COLD tiers together. A fact or"
- `packages/remnic-core/src/storage.ts:3390` — "// #1909 review round 15 (PR #2016): the content-hash dedup index is"
- `packages/remnic-core/src/storage.ts:3957` — "// Gate only the flush (issue #1909): the `.add(...)` above already set"
- `packages/remnic-core/src/storage.ts:3967` — "// A locked reconcile that times out defers to an unref'd background"
- `packages/remnic-core/src/storage.ts:4009` — "// Fact-ONLY answer (PR #2016). The shared content-hash index is"
- `packages/remnic-core/src/storage.ts:4087` — "// Cold-aware (issue #2330 round N+13 C): hot-only scans missed cold/ targets."
- `packages/remnic-core/src/storage.ts:4142` — "// PR #2016 thread SDzOP: serialize the removal with the per-index lock via"
