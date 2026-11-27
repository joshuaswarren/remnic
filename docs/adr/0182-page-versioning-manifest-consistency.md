# Page-version manifest mutations are cross-process locked, published atomically (rename) before any snapshot file is removed, and reconcile stranded commits - a crash or lost race can strand storage but never corrupt or delete a published rollback point.

Status: accepted

## Context
Two processes sharing a memory directory could compute the same next version id and stage colliding snapshots; a lost content CAS could delete the winner's rollback point; torn manifest writes and delete-before-publish ordering left unusable or dangling entries.

## Decision
Every manifest mutation takes a cross-process advisory lock (sibling `<manifest>.lock`, the established held-file-lock primitive) with a bounded wait; a lock that cannot be taken FAILS the mutation - staging falls back to the create path and removal/prune callers treat the throw as non-fatal, so no caller ever proceeds unsynchronized into the collision. Lock ownership is revalidated (mtime heartbeat, lstat) immediately before destructive writes, and a peer that stale-broke the lock and committed a mutation reusing this id causes the local staged write to abort rather than overwrite the peer's published rollback point.

Publication is atomic: write temp, rename over the manifest, and only then remove pruned snapshot files - a failed publication leaves manifest AND files untouched; the old delete-first order created manifest entries pointing at missing snapshots that getVersion/revert fail on and prune never cleans. Prune counts only COMMITTED snapshots (pending entries are never counted nor removed, so concurrent stagings cannot push history under the cap), and pruned files are removed only after their removal is durably published.

A finalization whose merge already committed but whose manifest write then failed appends the version id to an append-only `<manifest>.stranded` marker (one atomic O_APPEND line each; append-only by design - a rewrite could clobber an id appended by a finalization failing against the very lock the clear holds); the next prune reconciles those ids under the manifest lock. Stale marker lines are read-side no-ops. Recall-category dirs are derived from the single ALL_CATEGORY_DIRS source so newly routed categories are recognized when walking up to the memory root, and the snapshot-trigger runtime allow-list is derived from the trigger array so adding a trigger cannot drift.

## Consequences
Manifest mutations serialize behind a file lock (throughput cost outside daemon mode); a crash mid-attempt leaves a pending entry forever (bounded by one entry per crash, age-based expiry if crash loops ever make it matter); stranded markers add a small read-side skip per stale line.

> Note: this file merges smaller neighbouring themes that did not warrant their own ADR under the ten-file limit for this chunk.

## Origin comments
(76 records)
- `packages/remnic-core/src/page-versioning.ts:65` - "/** * Snapshot triggers. The runtime allow-list in `readManifest` is derived from * this array, so adding a trigger c"
- `packages/remnic-core/src/page-versioning.ts:121` - "// withPageLock serializes manifest mutations only within ONE Remnic process."
- `packages/remnic-core/src/page-versioning.ts:122` - "// Two processes sharing a memory directory could both read a manifest,"
- `packages/remnic-core/src/page-versioning.ts:123` - "// compute the SAME next version id, and stage colliding snapshots — and a"
- `packages/remnic-core/src/page-versioning.ts:124` - "// merge whose content CAS then lost called removeVersion on that shared id,"
- `packages/remnic-core/src/page-versioning.ts:125` - "// deleting the WINNER's committed rollback point (and concurrent"
- `packages/remnic-core/src/page-versioning.ts:126` - "// non-atomic manifest writes tore the JSON outright). The mutation now also"
- `packages/remnic-core/src/page-versioning.ts:127` - "// holds a cross-process advisory lock — the established withHeldFileLock"
- `packages/remnic-core/src/page-versioning.ts:128` - "// primitive, as a sibling `<manifest>.lock` file (the same `<data>.lock`"
- `packages/remnic-core/src/page-versioning.ts:129` - "// placement tombstones.jsonl and fact-hashes.txt use). A lock that cannot be"
- `packages/remnic-core/src/page-versioning.ts:130` - "// taken within the bounded wait FAILS the mutation: staging falls back to"
- `packages/remnic-core/src/page-versioning.ts:131` - "// the create path, and removal/prune callers already treat a throw as"
- `packages/remnic-core/src/page-versioning.ts:132` - "// non-fatal — no caller ever proceeds unsynchronized into the collision the"
- `packages/remnic-core/src/page-versioning.ts:133` - "// lock exists to prevent."
- `packages/remnic-core/src/page-versioning.ts:137` - "/** * A manifest mutation lost its advisory lock mid-section — a peer stale-broke * and replaced it, and the section "
- `packages/remnic-core/src/page-versioning.ts:151` - "/** * Revalidate lock ownership immediately before a destructive write (final * round B). The lock's mtime heartbeat "
- `packages/remnic-core/src/page-versioning.ts:287` - "// Final round (A): publish atomically — write the temp file, then rename"
- `packages/remnic-core/src/page-versioning.ts:288` - "// it over the manifest. A crash or transient failure can no longer leave a"
- `packages/remnic-core/src/page-versioning.ts:289` - "// torn or truncated manifest behind, and the publish-before-cleanup"
- `packages/remnic-core/src/page-versioning.ts:290` - "// ordering in every mutation guarantees a failed publication never strands"
- `packages/remnic-core/src/page-versioning.ts:291` - "// a manifest entry whose snapshot file is already gone."
- `packages/remnic-core/src/page-versioning.ts:302` - "// Round N+22: stranded-commit marker. A finalization whose merge had"
- `packages/remnic-core/src/page-versioning.ts:303` - "// ALREADY committed can still fail (manifest lock timeout, transient I/O),"
- `packages/remnic-core/src/page-versioning.ts:304` - "// leaving its staged entry `pending` forever — pruneExcessVersions excludes"
- `packages/remnic-core/src/page-versioning.ts:305` - "// pending entries, so every such failure stranded one unprunable snapshot"
- `packages/remnic-core/src/page-versioning.ts:306` - "// and repeated failures grew history past maxVersionsPerPage. The failed"
- `packages/remnic-core/src/page-versioning.ts:307` - "// finalization appends the (known-committed) version id to this marker (a"
- `packages/remnic-core/src/page-versioning.ts:308` - "// sibling `<manifest>.stranded` file, one id per line); the next"
- `packages/remnic-core/src/page-versioning.ts:309` - "// pruneVersions for the page reconciles those ids under the manifest lock."
- `packages/remnic-core/src/page-versioning.ts:310` - "// Append-only by design: a one-line O_APPEND write is atomic, and a"
- `packages/remnic-core/src/page-versioning.ts:311` - "// clear-side rewrite could clobber an id appended by a finalization that"
- `packages/remnic-core/src/page-versioning.ts:312` - "// just failed against the very lock the clear holds. Ids whose entry is gone"
- `packages/remnic-core/src/page-versioning.ts:313` - "// or already committed are read-side no-ops, so stale lines cost one skipped"
- `packages/remnic-core/src/page-versioning.ts:314` - "// lookup each and the file is bounded by finalization failures (one small"
- `packages/remnic-core/src/page-versioning.ts:315` - "// line each). A writer that CRASHES mid-attempt records nothing — that case"
- `packages/remnic-core/src/page-versioning.ts:316` - "// stays covered by the pending-exclusion itself."
- `packages/remnic-core/src/page-versioning.ts:382` - "// Final round (B): revalidate ownership immediately before the staged"
- `packages/remnic-core/src/page-versioning.ts:383` - "// snapshot write — a peer that stale-broke the lock may have committed a"
- `packages/remnic-core/src/page-versioning.ts:384` - "// mutation reusing this id, and overwriting its file would corrupt the"
- `packages/remnic-core/src/page-versioning.ts:385` - "// peer's published rollback point."
- `packages/remnic-core/src/page-versioning.ts:392` - "// Final round (A): the prune only COMPUTES the removal here; the"
- `packages/remnic-core/src/page-versioning.ts:393` - "// manifest publishes it (atomic rename), and only then are the pruned"
- `packages/remnic-core/src/page-versioning.ts:394` - "// snapshot files unlinked — a publication failure leaves the manifest"
- `packages/remnic-core/src/page-versioning.ts:395` - "// and the files exactly as they were, never a dangling reference."
- `packages/remnic-core/src/page-versioning.ts:396` - "// The prune is skipped when the caller deferred it until its guarded"
- `packages/remnic-core/src/page-versioning.ts:397` - "// write commits (issue #2330 round N+11 C)."
- `packages/remnic-core/src/page-versioning.ts:410` - "/** * Compute the excess COMMITTED snapshots and drop them from `history`, * returning the pruned entries WITHOUT tou"
- `packages/remnic-core/src/page-versioning.ts:422` - "// Round N+15 (B): count only COMMITTED snapshots. Two concurrent merges"
- `packages/remnic-core/src/page-versioning.ts:423` - "// can both stage (deferPrune) before either commits; a prune that counted"
- `packages/remnic-core/src/page-versioning.ts:424` - "// the other writer's pending entry would drop one more rollback point"
- `packages/remnic-core/src/page-versioning.ts:425` - "// than the cap requires, and that writer's abort (removeVersion) then"
- `packages/remnic-core/src/page-versioning.ts:426` - "// leaves history SHORT of the cap. Pending entries are skipped entirely —"
- `packages/remnic-core/src/page-versioning.ts:427` - "// never counted, never removed. (ponytail: a writer that dies mid-attempt"
- `packages/remnic-core/src/page-versioning.ts:428` - "// leaves its entry pending forever — bounded by one entry per crash;"
- `packages/remnic-core/src/page-versioning.ts:429` - "// age-based expiry if crash loops ever make that matter. A finalization"
- `packages/remnic-core/src/page-versioning.ts:430` - "// that fails AFTER its merge committed no longer strands its entry —"
- `packages/remnic-core/src/page-versioning.ts:431` - "// pruneVersions reconciles those from the stranded-commit marker, round"
- `packages/remnic-core/src/page-versioning.ts:432` - "// N+22.)"
- `packages/remnic-core/src/page-versioning.ts:447` - "/** * Best-effort removal of snapshot files whose removal the manifest has * ALREADY published (final round A). Owner"
- `packages/remnic-core/src/page-versioning.ts:516` - "// Marker ids are known-COMMITTED by construction: only a finalization"
- `packages/remnic-core/src/page-versioning.ts:517` - "// failure for an already-committed merge records one, so clearing them"
- `packages/remnic-core/src/page-versioning.ts:518` - "// here can never trade away a concurrent still-pending writer's entry."
- `packages/remnic-core/src/page-versioning.ts:529` - "// Final round (A): compute the prune, PUBLISH the manifest (atomic"
- `packages/remnic-core/src/page-versioning.ts:530` - "// rename), and only then unlink the pruned snapshot files best-effort —"
- `packages/remnic-core/src/page-versioning.ts:531` - "// a publication failure leaves manifest and files mutually consistent."
- `packages/remnic-core/src/page-versioning.ts:615` - "// Final round (A): PUBLISH the manifest (atomic rename) BEFORE touching"
- `packages/remnic-core/src/page-versioning.ts:616` - "// the snapshot file. The old order unlinked first — a publication"
- `packages/remnic-core/src/page-versioning.ts:617` - "// failure (transient I/O, full disk) then left the on-disk manifest"
- `packages/remnic-core/src/page-versioning.ts:618` - "// referencing a now-missing snapshot: an unusable rollback entry that"
- `packages/remnic-core/src/page-versioning.ts:619` - "// getVersion/revert fail on and prune never cleans. Publish-first means"
- `packages/remnic-core/src/page-versioning.ts:620` - "// a failed publication leaves manifest AND file untouched; the unlink"
- `packages/remnic-core/src/page-versioning.ts:621` - "// only runs once the removal is durably published."
- `packages/remnic-core/src/page-versioning.ts:837` - "// Derive the recall category dirs from ALL_CATEGORY_DIRS (single source of"
- `packages/remnic-core/src/page-versioning.ts:838` - "// truth) so newly-routed categories (decisions/, preferences/, ...) are"
- `packages/remnic-core/src/page-versioning.ts:839` - "// recognized when walking up to the memory root (#1546); the non-category"
- `packages/remnic-core/src/page-versioning.ts:840` - "// subdirs are listed explicitly."
