# Temporal indexes commit as atomic pairs and supersession preserves monotonic time

Status: accepted

## Context
A logical index mutation touches TWO files (temporal + tag), each with its own
write chain; overlapping mutators could interleave halves. Meanwhile temporal
supersession decides which fact is the current truth: stale wall-clock timestamps,
cross-tier duplicates, and hash-dedup promotions can all make a supersession event
appear to run backwards or silently skip, leaving stale facts active.

## Decision
Index consistency:
- Each public mutator wraps its paired writes in an operation-level mutex keyed by
  memoryDir; the temporal half commits first, and if its atomic write FAILS the tag
  half is NOT committed (a durable mismatch until a later index; both halves also
  fail open together). Batch mutations get a dedicated batch API so maintenance
  loops do not interleave.
- The sync (event-loop-blocking) surface acquires the SAME per-file lockdirs as the
  async surface, nested in a fixed order, with a BOUNDED wait (1.5s) that fails
  open — advisory indexes must never starve the Node event loop waiting on a lock
  held across an async await.
- `currentSchema` derives from the ACTUAL written index (hardcoding true made a
  deindex cache an old-schema index as current, skipping needed rebuilds); the
  index observer fires only after the committed rename, with its exceptions
  isolated so a test hook cannot turn a successful write into a retry or clear the
  cache and skip the tag phase. Group reads run as ONE consistent snapshot.
- Window parsing: "before <month>" anchors the lookback to the NAMED month start,
  not today-730 days (which could invert the window for an explicitly past month);
  a window that would be empty falls back to tomorrow as the exclusive upper bound;
  pattern priority mirrors recencyWindowFromPrompt (month name, then ago patterns,
  then explicit ISO/US/weekday patterns which override ago); with no lexical match,
  both chronology edges are retained so earliest/latest questions stay answerable.

Supersession:
- A new fact supersedes an older one for the same entity+attribute only when its
  persisted created timestamp is strictly newer; `supersededAt`/`updated` are the
  MONOTONIC MAX of (old.created, new.created, caller createdAt) — never a stale
  wall-clock value, and never earlier than the old fact's own createdAt. Time must
  not run backwards.
- Writes are CAS-guarded: re-read the target before patching; if a concurrent
  writer already marked it superseded, skip rather than clobber their supersededBy
  link.
- Scans cover BOTH tiers: cold copies (same frontmatter.id) are superseded too,
  and dedup keys on frontmatter.id (not path) so a memory visible in hot and cold
  during a migration is processed exactly once; a hot read failure must not mark
  the id processed before the cold copy is evaluated. Shared-namespace promotions
  run supersession against the shared storage, restricted to the SAME entity — a
  cross-entity content-hash collision is skipped, never used as an anchor.
- The hash-dedup promotion path still applies supersession (anchored to now, via
  max(persistedCreatedAt, caller createdAt), so an older existing fact cannot
  silently block retiring a stale one), its content hash uses the ENRICHED
  (raw + attributes suffix) body, and a throw in the supersession block must
  return — not fall through to a duplicate write.
- The kill switch is honest: when supersession is disabled, filters must NOT
  exclude superseded memories (the `enabled &&` short-circuit silently dropped
  them); the includeInRecall filter applies independently of other lifecycle
  flags.
- Supersession keys normalize hyphens and whitespace symmetrically.
- The cold-scan cache is invalidated only when cold content actually changes, and
  is cross-process checked via the cold-write sentinel, so burst hot writes reuse
  the cached scan instead of re-scanning cold/ on every write.

This file merges the temporal-index and temporal-supersession families (merged to
respect the ten-file cap) into one record.

## Consequences
Atomic pairing can leave an index half applied (both halves fail open together); monotonic-max timestamps mean a caller-supplied stale clock can never corrupt ordering, but the persisted time may differ from the caller's claim.

## Origin comments
- `packages/remnic-core/src/temporal-index-batch.ts:1` — "/** * Batch temporal/tag index mutations. * * Split from temporal-index.ts (issue #1911B / #1995): maintenance loops "
- `packages/remnic-core/src/temporal-index-compat.ts:25` — "// Bounded blocking-wait cap for the sync per-file lock (issue #1911, Cursor"
- `packages/remnic-core/src/temporal-index-compat.ts:167` — "// Bound the acquisition (issue #1911, Codex Medium). sleepSync() blocks the"
- `packages/remnic-core/src/temporal-index-compat.ts:238` — "// Coordinate with the ASYNC surface by acquiring the SAME per-file lockdirs"
- `packages/remnic-core/src/temporal-index.test.ts:269` — "// The tag half is NOT committed when the temporal write fails (issue #1911,"
- `packages/remnic-core/src/temporal-index.test.ts:440` — "// Both halves fail open together (issue #1911, Cursor Medium): the symlinked"
- `packages/remnic-core/src/temporal-index.ts:124` — "// Operation-level serialization keyed by memoryDir (issue #1911, Codex Medium):"
- `packages/remnic-core/src/temporal-index.ts:242` — "/** * Operation-level mutex keyed by memoryDir (issue #1911, Codex Medium). Wraps a * whole logical index mutation (w"
- `packages/remnic-core/src/temporal-index.ts:266` — "// Derive currentSchema from the ACTUAL written index (issue #1911, Codex):"
- `packages/remnic-core/src/temporal-index.ts:445` — "// The observer fires only after the committed rename. Isolate its"
- `packages/remnic-core/src/temporal-index.ts:952` — "// Write the temporal half first; if its atomic write FAILS, do NOT commit"
- `packages/remnic-core/src/temporal-index.ts:1172` — "// No lexical match (legacy rows or generic \"first/last\" query): retain"
- `packages/remnic-core/src/temporal-index.ts:1294` — "/** * Run a group of index reads as ONE consistent snapshot (issue #1911, Codex * Medium). The `read` callback execut"
- `packages/remnic-core/src/temporal-index.ts:1374` — "// \"before <month>\" means everything prior to that month: use 2-year lookback"
- `packages/remnic-core/src/temporal-index.ts:1488` — "// Mirror the structure of recencyWindowFromPrompt's else branch:"
- `packages/remnic-core/src/temporal-index.ts:1557` — "// Explicit date/weekday patterns run AFTER ago patterns (same as recencyWindowFromPrompt)"
- `packages/remnic-core/src/temporal-index.ts:1594` — "// fall back to tomorrow (exclusive upper bound that covers today) so we never produce"
- `packages/remnic-core/src/temporal-supersession.test.ts:73` — "Regression for round-5 review thread: hyphens and whitespace were not"
- `packages/remnic-core/src/temporal-supersession.test.ts:74` — "treated symmetrically \u2014 \"foo - bar\" (space-hyphen-space) produced"
- `packages/remnic-core/src/temporal-supersession.test.ts:75` — "\"foo---bar\" instead of \"foo-bar\"."
- `packages/remnic-core/src/temporal-supersession.test.ts:285` — "Ensure the new fact has a strictly greater created timestamp. The"
- `packages/remnic-core/src/temporal-supersession.test.ts:286` — "filename contains Date.now() so adding a small delay is sufficient for"
- `packages/remnic-core/src/temporal-supersession.test.ts:287` — "monotonic ISO timestamps at millisecond resolution."
- `packages/remnic-core/src/temporal-supersession.test.ts:550` — "The old fact is marked superseded (its city no longer current). The"
- `packages/remnic-core/src/temporal-supersession.test.ts:551` — "tool attribute survives by virtue of the surviving older fact still"
- `packages/remnic-core/src/temporal-supersession.test.ts:552` — "being on disk \u2014 the supersession linkage points to newCityOnly."
- `packages/remnic-core/src/temporal-supersession.test.ts:743` — "Seed an existing memory with a known T0 timestamp. Then write a newer"
- `packages/remnic-core/src/temporal-supersession.test.ts:744` — "memory (T1 > T0) and call applyTemporalSupersession. The old memory"
- `packages/remnic-core/src/temporal-supersession.test.ts:745` — "must be marked superseded regardless of when the wall clock is sampled."
- `packages/remnic-core/src/temporal-supersession.test.ts:766` — "Pass a stale wall-clock time that is EARLIER than T0 \u2014 the fix should"
- `packages/remnic-core/src/temporal-supersession.test.ts:767` — "ignore this in favour of the on-disk T1 for the new memory."
- `packages/remnic-core/src/temporal-supersession.test.ts:792` — "Finding 2 regression: when the caller-supplied `createdAt` is earlier"
- `packages/remnic-core/src/temporal-supersession.test.ts:793` — "than the old memory's persisted `created`, the written `supersededAt`"
- `packages/remnic-core/src/temporal-supersession.test.ts:794` — "must not predate the old memory's own createdAt \u2014 otherwise the"
- `packages/remnic-core/src/temporal-supersession.test.ts:795` — "supersession event appears to occur before the fact it supersedes."
- `packages/remnic-core/src/temporal-supersession.test.ts:797` — "Setup: old fact persisted at T_old = 2026-04-11T12:00:00Z."
- `packages/remnic-core/src/temporal-supersession.test.ts:798` — "New fact persisted at T_new = 2026-04-11T13:00:00Z (newer \u2014 so old is"
- `packages/remnic-core/src/temporal-supersession.test.ts:799` — "eligible for supersession)."
- `packages/remnic-core/src/temporal-supersession.test.ts:800` — "Caller passes stale wall-clock createdAt = 2026-04-11T11:00:00Z"
- `packages/remnic-core/src/temporal-supersession.test.ts:801` — "(earlier than BOTH). The written supersededAt must equal the max of"
- `packages/remnic-core/src/temporal-supersession.test.ts:802` — "the three (T_new = 13:00), never the stale 11:00."
- `packages/remnic-core/src/temporal-supersession.test.ts:839` — "The written supersededAt / updated must be the monotonic max \u2014 the"
- `packages/remnic-core/src/temporal-supersession.test.ts:840` — "new fact's persisted T_new \u2014 NOT the stale wall-clock value."
- `packages/remnic-core/src/temporal-supersession.test.ts:851` — "Sanity check: supersededAt is never earlier than the old fact's own"
- `packages/remnic-core/src/temporal-supersession.test.ts:852` — "createdAt \u2014 time must not run backwards."
- `packages/remnic-core/src/temporal-supersession.test.ts:865` — "Simulate stale extraction: an existing memory has T1 (newer) but a new"
- `packages/remnic-core/src/temporal-supersession.test.ts:866` — "write arrives with T0 (older persisted created). The existing T1 memory"
- `packages/remnic-core/src/temporal-supersession.test.ts:867` — "should NOT be superseded because it is newer."
- `packages/remnic-core/src/temporal-supersession.test.ts:897` — "The stale write (T0) is older than the existing memory (T1), so it"
- `packages/remnic-core/src/temporal-supersession.test.ts:898` — "cannot supersede it."
- `packages/remnic-core/src/temporal-supersession.test.ts:909` — "Simulates two writers racing: writer A reads the memory snapshot, decides"
- `packages/remnic-core/src/temporal-supersession.test.ts:910` — "to supersede candidate X, but before A actually patches X, writer B beats"
- `packages/remnic-core/src/temporal-supersession.test.ts:911` — "A to it and marks X superseded with B's id. A must notice on re-read and"
- `packages/remnic-core/src/temporal-supersession.test.ts:912` — "skip the write so it does not clobber B's supersededBy link."
- `packages/remnic-core/src/temporal-supersession.test.ts:914` — "We emulate the race by intercepting `readAllMemories` so that it returns"
- `packages/remnic-core/src/temporal-supersession.test.ts:915` — "a stale \"active\" snapshot, then mutate disk with the concurrent writer's"
- `packages/remnic-core/src/temporal-supersession.test.ts:916` — "patch. applyTemporalSupersession's CAS re-read via readMemoryByPath()"
- `packages/remnic-core/src/temporal-supersession.test.ts:917` — "will see the real disk state and must skip the write."
- `packages/remnic-core/src/temporal-supersession.test.ts:1010` — "Scenario: a logical memory with id X exists in BOTH hot and cold lists"
- `packages/remnic-core/src/temporal-supersession.test.ts:1011` — "(this can happen during a tier migration). The hot entry is listed first"
- `packages/remnic-core/src/temporal-supersession.test.ts:1012` — "in allCandidates. When readMemoryByPath throws/returns null for the hot"
- `packages/remnic-core/src/temporal-supersession.test.ts:1013` — "path (the file has already moved), the id must NOT be added to processedIds"
- `packages/remnic-core/src/temporal-supersession.test.ts:1014` — "yet \u2014 the cold copy (same frontmatter.id) must still get a chance to be"
- `packages/remnic-core/src/temporal-supersession.test.ts:1015` — "evaluated and superseded."
- `packages/remnic-core/src/temporal-supersession.test.ts:1017` — "We simulate this by writing two physical files with the same frontmatter.id,"
- `packages/remnic-core/src/temporal-supersession.test.ts:1018` — "injecting them as hot/cold via a monkey-patched readAllMemories, and making"
- `packages/remnic-core/src/temporal-supersession.test.ts:1019` — "the first readMemoryByPath call return null (as-if the hot file vanished)."
- `packages/remnic-core/src/temporal-supersession.test.ts:1072` — "The cold copy (real path) must have been superseded. If the bug were"
- `packages/remnic-core/src/temporal-supersession.test.ts:1073` — "present, processedIds would be marked after the hot read fails and the"
- `packages/remnic-core/src/temporal-supersession.test.ts:1074` — "cold copy would be skipped, leaving result.supersededIds empty."
- `packages/remnic-core/src/temporal-supersession.test.ts:1164` — "Regression for Finding 2+3: when temporalSupersessionEnabled=false, the"
- `packages/remnic-core/src/temporal-supersession.test.ts:1165` — "recent-scan prefilter must NOT exclude superseded memories. This mirrors"
- `packages/remnic-core/src/temporal-supersession.test.ts:1166` — "the boostSearchResults (QMD) path, which also returns false when disabled."
- `packages/remnic-core/src/temporal-supersession.test.ts:1168` — "The recent-scan filter previously checked `enabled && includeInRecall`"
- `packages/remnic-core/src/temporal-supersession.test.ts:1169` — "directly, so a superseded memory was silently excluded even when the"
- `packages/remnic-core/src/temporal-supersession.test.ts:1170` — "feature was disabled \u2014 inconsistent with the QMD path and contrary to the"
- `packages/remnic-core/src/temporal-supersession.test.ts:1171` — "kill-switch intent."
- `packages/remnic-core/src/temporal-supersession.test.ts:1382` — "Finding A / C regression: supersession filter must apply independently of"
- `packages/remnic-core/src/temporal-supersession.test.ts:1383` — "any lifecycle flag. If temporalSupersessionIncludeInRecall is false, a"
- `packages/remnic-core/src/temporal-supersession.test.ts:1384` — "superseded memory should always be filtered, even when the caller would"
- `packages/remnic-core/src/temporal-supersession.test.ts:1385` — "otherwise allow lifecycle-filtered (archived/retired) candidates."
- `packages/remnic-core/src/temporal-supersession.test.ts:1423` — "applyTemporalSupersession previously only scanned the hot tier via"
- `packages/remnic-core/src/temporal-supersession.test.ts:1424` — "readAllMemories(). Memories already demoted to cold/ were never marked"
- `packages/remnic-core/src/temporal-supersession.test.ts:1425` — "superseded, so cold fallback retrieval could surface stale truths when hot"
- `packages/remnic-core/src/temporal-supersession.test.ts:1426` — "had no hits."
- `packages/remnic-core/src/temporal-supersession.test.ts:1446` — "A memory is written to hot, then demoted to cold/. A newer hot fact"
- `packages/remnic-core/src/temporal-supersession.test.ts:1447` — "arrives for the same entity+attribute. The cold memory must be marked"
- `packages/remnic-core/src/temporal-supersession.test.ts:1448` — "superseded \u2014 the bug left it active because the scan never looked in cold/."
- `packages/remnic-core/src/temporal-supersession.test.ts:1522` — "Hot memory (city=Austin, older) and cold memory (city=Dallas, older) both"
- `packages/remnic-core/src/temporal-supersession.test.ts:1523` — "share the city key. After the run, both must be superseded and neither"
- `packages/remnic-core/src/temporal-supersession.test.ts:1524` — "should be processed twice (dedup by path)."
- `packages/remnic-core/src/temporal-supersession.test.ts:1566` — "CAS regression for cold tier: supersededAt must be the monotonic max of"
- `packages/remnic-core/src/temporal-supersession.test.ts:1567` — "(cold.created, hot.created, args.createdAt) \u2014 same guarantee as hot tier."
- `packages/remnic-core/src/temporal-supersession.test.ts:1636` — "When the same logical memory (same frontmatter.id) is visible in both hot"
- `packages/remnic-core/src/temporal-supersession.test.ts:1637` — "and cold tiers during a migration race, the old processedPaths dedup would"
- `packages/remnic-core/src/temporal-supersession.test.ts:1638` — "NOT catch it (different paths \u2192 different set entries) and would process it"
- `packages/remnic-core/src/temporal-supersession.test.ts:1639` — "twice. The fix keys on frontmatter.id instead."
- `packages/remnic-core/src/temporal-supersession.test.ts:1756` — "After a fact is promoted to the shared namespace, applyTemporalSupersession"
- `packages/remnic-core/src/temporal-supersession.test.ts:1757` — "must be run against the shared storage so that older shared copies of the"
- `packages/remnic-core/src/temporal-supersession.test.ts:1758` — "same entity attribute are retired. This test verifies the helper's"
- `packages/remnic-core/src/temporal-supersession.test.ts:1759` — "cross-storage semantics by calling it directly against a separate storage"
- `packages/remnic-core/src/temporal-supersession.test.ts:1760` — "instance (simulating shared namespace storage)."
- `packages/remnic-core/src/temporal-supersession.test.ts:1825` — "Previously readAllColdMemories only scanned cold/facts/ and cold/corrections/."
- `packages/remnic-core/src/temporal-supersession.test.ts:1826` — "Any memory stored in a non-standard cold subdirectory (e.g. cold/preferences/)"
- `packages/remnic-core/src/temporal-supersession.test.ts:1827` — "would be silently skipped. After the fix, the scan starts from the cold root"
- `packages/remnic-core/src/temporal-supersession.test.ts:1828` — "and recurses into every subdirectory."
- `packages/remnic-core/src/temporal-supersession.test.ts:1901` — "Finding UvBq (PR #402 round-11): invalidateAllMemoriesCache() previously also"
- `packages/remnic-core/src/temporal-supersession.test.ts:1902` — "cleared coldMemoriesCache on every hot-tier write (writeMemory), which defeated"
- `packages/remnic-core/src/temporal-supersession.test.ts:1903` — "the burst-dedup optimisation \u2014 each write in a burst caused applyTemporalSupersession"
- `packages/remnic-core/src/temporal-supersession.test.ts:1904` — "to re-scan the entire cold/ tree from disk. The fix limits cold-cache eviction to"
- `packages/remnic-core/src/temporal-supersession.test.ts:1905` — "invalidateColdMemoriesCache(), which is only called when cold content actually changes"
- `packages/remnic-core/src/temporal-supersession.test.ts:1906` — "(hot\u2192cold demotions, writeMemoryFrontmatter on cold paths, etc.)."
- `packages/remnic-core/src/temporal-supersession.test.ts:1970` — "The cold cache is process-local. Before Finding UvUy, a second process that"
- `packages/remnic-core/src/temporal-supersession.test.ts:1971` — "wrote a new cold memory would not be detected by the first process until the"
- `packages/remnic-core/src/temporal-supersession.test.ts:1972` — "30s TTL expired. The fix adds a file-size sentinel (state/cold-write.log)"
- `packages/remnic-core/src/temporal-supersession.test.ts:1973` — "that is bumped on every cold write. readAllColdMemories() compares the cached"
- `packages/remnic-core/src/temporal-supersession.test.ts:1974` — "sentinel against the on-disk sentinel before serving cached data."
- `packages/remnic-core/src/temporal-supersession.test.ts:2025` — "readAllColdMemories() previously performed an uncached full-tree directory scan"
- `packages/remnic-core/src/temporal-supersession.test.ts:2026` — "on every structured-attribute write call. After the fix it caches the result"
- `packages/remnic-core/src/temporal-supersession.test.ts:2027` — "for COLD_SCAN_CACHE_TTL_MS; back-to-back hot-tier writes in the same burst"
- `packages/remnic-core/src/temporal-supersession.test.ts:2028` — "reuse the cached result instead of re-scanning."
- `packages/remnic-core/src/temporal-supersession.test.ts:2032` — "When `hasFactContentHash` fires and the promotion short-circuits (the shared"
- `packages/remnic-core/src/temporal-supersession.test.ts:2033` — "namespace already contains the same raw content), the temporal supersession"
- `packages/remnic-core/src/temporal-supersession.test.ts:2034` — "block was never reached. The fix runs `applyTemporalSupersession` against"
- `packages/remnic-core/src/temporal-supersession.test.ts:2035` — "the existing shared fact even on the hash-dedup path so that older conflicting"
- `packages/remnic-core/src/temporal-supersession.test.ts:2036` — "shared facts are still retired."
- `packages/remnic-core/src/temporal-supersession.test.ts:2096` — "The older conflicting shared fact (city=Austin, T0) must be superseded."
- `packages/remnic-core/src/temporal-supersession.test.ts:2097` — "Without the hash-dedup fix, this call was never made, so the stale fact"
- `packages/remnic-core/src/temporal-supersession.test.ts:2098` — "would remain active."
- `packages/remnic-core/src/temporal-supersession.test.ts:2200` — "In the hash-dedup promotion path, supersession was anchored to"
- `packages/remnic-core/src/temporal-supersession.test.ts:2201` — "matchingFact.frontmatter.created (the existing shared fact's creation time)."
- `packages/remnic-core/src/temporal-supersession.test.ts:2202` — "If that existing fact was older than the conflicting stale fact being retired,"
- `packages/remnic-core/src/temporal-supersession.test.ts:2203` — "supersession would refuse to fire because it would look like a stale write"
- `packages/remnic-core/src/temporal-supersession.test.ts:2204` — "(new.created < existing.created). The fix anchors to new Date().toISOString()"
- `packages/remnic-core/src/temporal-supersession.test.ts:2205` — "(the current write time) so supersession always runs as a fresh event."
- `packages/remnic-core/src/temporal-supersession.test.ts:2208` — "Scenario: shared namespace has two facts \u2014"
- `packages/remnic-core/src/temporal-supersession.test.ts:2209` — "factOld: entity.city = Austin, created = T_very_old (well before both others)"
- `packages/remnic-core/src/temporal-supersession.test.ts:2210` — "factMatch: entity.city = NYC, created = T_mid (the \"matching\" fact the hash-dedup finds)"
- `packages/remnic-core/src/temporal-supersession.test.ts:2211` — "The incoming promotion event is happening NOW (T_now > both)."
- `packages/remnic-core/src/temporal-supersession.test.ts:2212` — "When the hash-dedup path passes factMatch.frontmatter.created as createdAt,"
- `packages/remnic-core/src/temporal-supersession.test.ts:2213` — "T_mid is used as the \"new\" time \u2014 but factOld.created may be similar in age"
- `packages/remnic-core/src/temporal-supersession.test.ts:2214` — "to T_mid, causing the ordering check to fail or be ambiguous."
- `packages/remnic-core/src/temporal-supersession.test.ts:2215` — "With the fix, T_now is passed so the ordering is unambiguous."
- `packages/remnic-core/src/temporal-supersession.test.ts:2258` — "Sanity: if we had passed T_mid (the wrong value, the old bug), supersession"
- `packages/remnic-core/src/temporal-supersession.test.ts:2259` — "would still fire here because T_mid > T_very_old \u2014 but in the real bug the"
- `packages/remnic-core/src/temporal-supersession.test.ts:2260` — "existing fact's created can be OLDER than the stale fact's created, flipping"
- `packages/remnic-core/src/temporal-supersession.test.ts:2261` — "the ordering. Demonstrate that ordering is the critical invariant."
- `packages/remnic-core/src/temporal-supersession.test.ts:2271` — "Strategy: populate the cold-scan cache via a first readAllColdMemories() call."
- `packages/remnic-core/src/temporal-supersession.test.ts:2272` — "Then add a new .md file directly to cold/ WITHOUT going through"
- `packages/remnic-core/src/temporal-supersession.test.ts:2273` — "migrateMemoryToTier (which would invalidate the cache). A second call to"
- `packages/remnic-core/src/temporal-supersession.test.ts:2274` — "readAllColdMemories() must return the CACHED snapshot (missing the new file),"
- `packages/remnic-core/src/temporal-supersession.test.ts:2275` — "proving the cache was not re-read from disk."
- `packages/remnic-core/src/temporal-supersession.test.ts:2277` — "This mirrors the real burst-write scenario: N hot-tier writes happen without"
- `packages/remnic-core/src/temporal-supersession.test.ts:2278` — "any cold demotion, so the cold-scan cache remains valid across all N calls."
- `packages/remnic-core/src/temporal-supersession.test.ts:2335` — "When the shared hash-dedup path finds a memory with matching content, it must"
- `packages/remnic-core/src/temporal-supersession.test.ts:2336` — "restrict the match to the SAME entity. If two entities share identical fact"
- `packages/remnic-core/src/temporal-supersession.test.ts:2337` — "text, the older-entity fact must NOT be used as the supersession anchor for"
- `packages/remnic-core/src/temporal-supersession.test.ts:2338` — "the incoming entity, as that would create incorrect cross-entity supersededBy"
- `packages/remnic-core/src/temporal-supersession.test.ts:2339` — "links and could hide valid memories for either entity."
- `packages/remnic-core/src/temporal-supersession.test.ts:2341` — "This test verifies that a cross-entity content-hash collision is silently"
- `packages/remnic-core/src/temporal-supersession.test.ts:2342` — "skipped and leaves both entities' memories untouched."
- `packages/remnic-core/src/temporal-supersession.test.ts:2373` — "With the fix, shouldSupersedeExisting returns null for entity-alpha's stale"
- `packages/remnic-core/src/temporal-supersession.test.ts:2374` — "memory (ENTITY_A !== ENTITY_B), so no supersession fires."
- `packages/remnic-core/src/temporal-supersession.test.ts:2416` — "In the hash-dedup path, `applyTemporalSupersession` is called with"
- `packages/remnic-core/src/temporal-supersession.test.ts:2417` — "`newMemoryId` pointing to the OLD existing matching fact (no new file is"
- `packages/remnic-core/src/temporal-supersession.test.ts:2418` — "written). Line 203 resolves `persistedCreatedAt` from that old fact's"
- `packages/remnic-core/src/temporal-supersession.test.ts:2419` — "`frontmatter.created`, which can be arbitrarily old \u2014 older than the"
- `packages/remnic-core/src/temporal-supersession.test.ts:2420` — "conflicting stale fact being retired. When `persistedCreatedAt < stale.created`,"
- `packages/remnic-core/src/temporal-supersession.test.ts:2421` — "the ordering guard `candidateCreated >= newCreated` fires and supersession is"
- `packages/remnic-core/src/temporal-supersession.test.ts:2422` — "silently skipped, leaving stale data active."
- `packages/remnic-core/src/temporal-supersession.test.ts:2424` — "The fix takes `max(persistedCreatedAt, args.createdAt)` so that the caller's"
- `packages/remnic-core/src/temporal-supersession.test.ts:2425` — "wall-clock timestamp (always \"now\") wins when the persisted value is stale."
- `packages/remnic-core/src/temporal-supersession.test.ts:2435` — "Bug: persistedCreatedAt = T_very_old < T_mid \u2192 ordering guard fires \u2192 NO supersession."
- `packages/remnic-core/src/temporal-supersession.test.ts:2436` — "Fix: persistedCreatedAt = max(T_very_old, T_now) = T_now > T_mid \u2192 supersession fires."
- `packages/remnic-core/src/temporal-supersession.test.ts:2461` — "Before the fix: persistedCreatedAt = T_very_old < T_mid \u2192 no supersession."
- `packages/remnic-core/src/temporal-supersession.test.ts:2462` — "After the fix: useCallerTimestamp=true \u2192 persistedCreatedAt = T_now > T_mid \u2192 supersession fires."
- `packages/remnic-core/src/temporal-supersession.test.ts:2497` — "When the hash-dedup block finds a matchingFact and applyTemporalSupersession"
- `packages/remnic-core/src/temporal-supersession.test.ts:2498` — "throws, the original code fell through to writeMemory, creating a duplicate"
- `packages/remnic-core/src/temporal-supersession.test.ts:2499` — "shared entry. The fix adds `return` in the catch block to prevent the"
- `packages/remnic-core/src/temporal-supersession.test.ts:2500` — "fall-through. This test validates the invariant at the storage level: after"
- `packages/remnic-core/src/temporal-supersession.test.ts:2501` — "hasFactContentHash fires for an enriched fact, a second writeMemory with the"
- `packages/remnic-core/src/temporal-supersession.test.ts:2502` — "same enriched content must still only produce ONE entry in the index."
- `packages/remnic-core/src/temporal-supersession.test.ts:2505` — "PR #402 round-6 Fix #2 regression: the hash check must use the ENRICHED"
- `packages/remnic-core/src/temporal-supersession.test.ts:2506` — "content (raw + [Attributes: ...] suffix) so that:"
- `packages/remnic-core/src/temporal-supersession.test.ts:2507` — "a) two promotions of the SAME raw+enriched body correctly dedup (one entry),"
- `packages/remnic-core/src/temporal-supersession.test.ts:2508` — "b) two promotions of the same raw body but DIFFERENT enrichments do NOT dedup."
- `packages/remnic-core/src/temporal-supersession.test.ts:2571` — "Validates that when hasFactContentHash fires (content already in index), the"
- `packages/remnic-core/src/temporal-supersession.test.ts:2572` — "duplicate write path is blocked. We simulate the invariant at the storage"
- `packages/remnic-core/src/temporal-supersession.test.ts:2573` — "level: writing the same enriched content twice must not create two facts."
