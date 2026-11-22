# Supersession scans hot then cold as one deduplicated snapshot with CAS re-read before each write

Status: accepted

## Context
File storage has no locking; snapshots go stale under concurrent writers and hot/cold migration can duplicate a logical memory across tiers. Hot-then-cold ordering, id-keyed dedup, deferred processed-id marking, and the CAS-style re-read together make the scan safe without a lock; the cost is one extra read per candidate write and a TTL window of eventual consistency on the cold cache.

## Decision
Supersession evaluates candidates across the hot and cold tiers as a single combined scan, guarded against migration races and concurrent writers.

Rules:
- Process hot, then cold; a Set keyed on `frontmatter.id` (path fallback when absent) ensures a memory visible in both tiers is processed at most once. The cold scan is never skipped when hot produced zero supersessions — stale cold facts leak precisely in that case.
- `readAllColdMemories` performs a full uncached recursive scan of cold/ whose cost grows with the tree; results are cached in StorageManager for COLD_SCAN_CACHE_TTL_MS, invalidated on any hot→cold demotion, so back-to-back writes in a burst pay cold I/O at most once.
- A stale non-active snapshot entry must not suppress an active copy of the same logical memory in another tier: ids are marked processed only AFTER the CAS re-read succeeds; a failed primary-tier read grants the alternate tier a chance to process the id, and after a confirmed non-matching entry the id is marked so the alternate tier does not re-evaluate it.
- Before superseding a candidate, re-read the exact file, verify it is still active with no `supersededBy`, and only then write; skip if a concurrent writer won. A hash-dedup promotion replacement is resolved from the combined snapshot so cold-only memories supply captured content rather than a null payload.

## Consequences
See Decision: each rule pairs the constraint that forced it with its cost (extra reads and realpath work, explicit caller options, maintenance of shared helpers and gate regexes). Where topics were merged into this theme as nearest neighbours rather than standalone ADRs, that is noted here: the small single-site topics are absorbed into the theme whose files and failure modes they share.

## Origin comments
- `packages/remnic-core/src/temporal-supersession.ts:720` — "// Process hot then cold. Hot-then-cold ordering is safer because hot"
- `packages/remnic-core/src/temporal-supersession.ts:721` — "// writes are more frequent and the CAS re-read guards against double-writes."
- `packages/remnic-core/src/temporal-supersession.ts:722` — "// A Set<string> of already-processed ids ensures that a memory visible in"
- `packages/remnic-core/src/temporal-supersession.ts:723` — "// both tiers (same logical memory with different filesystem paths during a"
- `packages/remnic-core/src/temporal-supersession.ts:724` — "// migration race) is processed at most once. Keying on `frontmatter.id`"
- `packages/remnic-core/src/temporal-supersession.ts:725` — "// is correct because the same logical memory has the same id regardless of"
- `packages/remnic-core/src/temporal-supersession.ts:726` — "// which tier's directory it currently lives in (PR #402 Finding 1 fix)."
- `packages/remnic-core/src/temporal-supersession.ts:727` — "// Fall back to path-based keying when id is absent (defensive)."
- `packages/remnic-core/src/temporal-supersession.ts:755` — "// Combine hot and cold memories into a single scan. New memory itself is"
- `packages/remnic-core/src/temporal-supersession.ts:756` — "// excluded inline. We do NOT skip cold scan when hot produced zero"
- `packages/remnic-core/src/temporal-supersession.ts:757` — "// supersessions — the P1 finding is precisely that stale cold facts leak"
- `packages/remnic-core/src/temporal-supersession.ts:758` — "// when hot has no hits."
- `packages/remnic-core/src/temporal-supersession.ts:760` — "// Resolve the replacement from the combined hot and cold snapshot. A"
- `packages/remnic-core/src/temporal-supersession.ts:761` — "// hash-dedup promotion can point at a cold-only memory, and replay needs its"
- `packages/remnic-core/src/temporal-supersession.ts:762` — "// captured content rather than a null replacement payload."
- `packages/remnic-core/src/temporal-supersession.ts:730` — "// Finding UOGi fix (round-6): readAllColdMemories() performs a full uncached"
- `packages/remnic-core/src/temporal-supersession.ts:731` — "// recursive directory scan of cold/. After Finding UTsP broadened the scan"
- `packages/remnic-core/src/temporal-supersession.ts:732` — "// to cover the entire cold root (not just facts/+corrections/), the per-call"
- `packages/remnic-core/src/temporal-supersession.ts:733` — "// cost grows with the cold tree size."
- `packages/remnic-core/src/temporal-supersession.ts:735` — "// The fix is a TTL-based in-memory cache inside StorageManager"
- `packages/remnic-core/src/temporal-supersession.ts:736` — "// (readAllColdMemories caches its result for COLD_SCAN_CACHE_TTL_MS) that is"
- `packages/remnic-core/src/temporal-supersession.ts:737` — "// shared across consecutive supersession calls within the same write burst."
- `packages/remnic-core/src/temporal-supersession.ts:738` — "// The cache is invalidated automatically on any hot→cold demotion (which"
- `packages/remnic-core/src/temporal-supersession.ts:739` — "// calls invalidateAllMemoriesCache, which also clears the cold cache) and"
- `packages/remnic-core/src/temporal-supersession.ts:740` — "// expires after the TTL as a safety net."
- `packages/remnic-core/src/temporal-supersession.ts:742` — "// This means back-to-back structured-attribute writes in the same burst"
- `packages/remnic-core/src/temporal-supersession.ts:743` — "// (e.g. batch extraction) pay the cold I/O cost at most once, not N times."
- `packages/remnic-core/src/temporal-supersession.ts:744` — "// Correctness is preserved because the cache TTL ensures eventual consistency"
- `packages/remnic-core/src/temporal-supersession.ts:745` — "// and the invalidation hook covers the hot→cold path."
- `packages/remnic-core/src/temporal-supersession.ts:772` — "// A stale non-active snapshot entry must not suppress an active copy of"
- `packages/remnic-core/src/temporal-supersession.ts:773` — "// the same logical memory that appears later in another tier. This can"
- `packages/remnic-core/src/temporal-supersession.ts:774` — "// happen during hot/cold migration races where the hot snapshot is already"
- `packages/remnic-core/src/temporal-supersession.ts:775` — "// superseded but the cold copy is still active and should be evaluated."
- `packages/remnic-core/src/temporal-supersession.ts:778` — "// NOTE: do NOT call processedIds.add(dedupeKey) here. We defer marking"
- `packages/remnic-core/src/temporal-supersession.ts:779` — "// the id as processed until AFTER the CAS re-read succeeds. If we mark"
- `packages/remnic-core/src/temporal-supersession.ts:780` — "// it here and the re-read fails (e.g. the hot entry has already been"
- `packages/remnic-core/src/temporal-supersession.ts:781` — "// migrated to cold storage), the same logical id that appears later in"
- `packages/remnic-core/src/temporal-supersession.ts:782` — "// the cold tier scan would be silently skipped, leaving a stale cold"
- `packages/remnic-core/src/temporal-supersession.ts:783` — "// fact unsuperseded. Deferring ensures that a failed primary-tier read"
- `packages/remnic-core/src/temporal-supersession.ts:784` — "// grants the alternate tier a chance to process the same id (PR #402"
- `packages/remnic-core/src/temporal-supersession.ts:785` — "// round-6 Finding 1 fix)."
- `packages/remnic-core/src/temporal-supersession.ts:795` — "// No supersession decision — safe to mark as processed now so the"
- `packages/remnic-core/src/temporal-supersession.ts:796` — "// alternate tier doesn't re-evaluate an identical non-matching entry."
- `packages/remnic-core/src/temporal-supersession.ts:821` — "// Mark as processed AFTER confirming the candidate is readable so that"
- `packages/remnic-core/src/temporal-supersession.ts:822` — "// a migration-race read failure on the hot entry does not silently"
- `packages/remnic-core/src/temporal-supersession.ts:823` — "// prevent the cold entry from being evaluated (Finding 1, round 6)."
- `packages/remnic-core/src/temporal-supersession.ts:829` — "// Do NOT add to processedIds — allow the cold-tier copy to be"
- `packages/remnic-core/src/temporal-supersession.ts:830` — "// evaluated in the next iteration of the same scan."
- `packages/remnic-core/src/temporal-supersession.ts:833` — "// Candidate is readable — mark the id as processed now to prevent the"
- `packages/remnic-core/src/temporal-supersession.ts:834` — "// alternate tier from double-writing."
- `packages/remnic-core/src/temporal-supersession.ts:810` — "// CAS-style re-read immediately before the write. `readAllMemories()`"
- `packages/remnic-core/src/temporal-supersession.ts:811` — "// is a snapshot — with concurrent writers, another run may have already"
- `packages/remnic-core/src/temporal-supersession.ts:812` — "// superseded this candidate since we loaded it. If we blindly trust the"
- `packages/remnic-core/src/temporal-supersession.ts:813` — "// snapshot we can clobber a newer `supersededBy` link with a stale one."
- `packages/remnic-core/src/temporal-supersession.ts:814` — "//"
- `packages/remnic-core/src/temporal-supersession.ts:815` — "// File storage offers no true locking, so the best we can do is:"
- `packages/remnic-core/src/temporal-supersession.ts:816` — "// 1. re-read the exact file we're about to mutate"
- `packages/remnic-core/src/temporal-supersession.ts:817` — "// 2. verify status is still "active" and no `supersededBy` is set"
- `packages/remnic-core/src/temporal-supersession.ts:818` — "// 3. only then issue the write"
- `packages/remnic-core/src/temporal-supersession.ts:819` — "// If the re-read shows a newer concurrent writer beat us to it, skip."
- `packages/remnic-core/src/temporal-supersession.ts:820` — "// This CAS pattern applies equally to hot and cold tier candidates."
