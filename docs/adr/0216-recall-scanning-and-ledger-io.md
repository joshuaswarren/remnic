# Recall scans cover every category and cold tier, with bounded, crash-safe ledger I/O

Status: accepted

## Context
The QMD filesystem-fallback recall path must find every memory regardless of
category directory or cold-tier layout, while cross-process writes and very large
or hostile encrypted files threaten stale caches, unbounded memory, and symlink/
FIFO attacks. Targeted-fact recall additionally must not let a weak primary-key
hit mask stronger fallback evidence.

## Decision
- Fallback recall scans EVERY supported memory category directory (single source
  of truth: RECALL_FALLBACK_DIRS derived from ALL_CATEGORY_DIRS, namespace-aware
  via the per-namespace baseDir), not just the legacy four. Deliberately excluded:
  non-category dirs (entities/, state/, artifacts/, identity/, config/),
  profile.md, and the questions/ queue dir — the QMD primary corpus excludes them
  too (corpus parity), and scanning questions/ would leak queue items into recall.
  The exclusion is asserted by tests.
- Cold-tier reads scan the entire cold root tree, not facts/+corrections/ only, so
  any memory with structuredAttributes is found regardless of category. The cold
  scan cache is validated against the on-disk cold-write sentinel (state file
  size) BEFORE serving, so another process's cold write is detected immediately
  instead of after the 30s TTL; the cache is additionally keyed on the secure-store
  key identity so a differently-keyed manager cannot read another instance's
  corpus. Cache eviction on hot writes is limited to actual cold-content changes so
  burst writes do not re-scan the whole tree; a raw-free read stays out of the
  cache.
- Ledger reads are bounded: per-row decode caps, streaming line yields that never
  materialize the whole decrypted body, and a min-heap bounded tail read.
- Pending appends spill to durable, uniquely-named, immutable spill files when the
  lock cannot be acquired; draining claims ONE bounded batch via a crash-safe
  rename (content read lazily, read at the AAD-bound original path BEFORE claiming
  so a failure leaves the file for retry, stopping before a spill that would
  overflow the batch), folds it under the ledger lock without appending a new
  event, deletes claimed files only after durable commit (a failed delete leaves an
  orphan the next drain retries), and rolls a failed commit's claims back to
  unclaimed so they retry as normal spills. The pending dir listing rejects
  symlinks and skips symlinked/escaping entries BEFORE secure-read or unlink, so a
  poisoned link cannot redirect decrypt/delete outside the spill dir.
- Appends serialize against compaction under the cross-process ledger lock.
- Whole-file decrypt has a ceiling tied to V8's max string length, with the remedy
  namespace-aware (an oversized ledger under a namespace must not be pointed at a
  root-only command). Callers with no compaction remedy take no ceiling — their
  decryption behaves exactly as before. Symlink/FIFO/device files are rejected
  BEFORE opening (a FIFO blocks until a writer appears; a symlink redirects reads
  outside the tree), while ENOENT keeps absent-file-to-empty behavior.
- Bounded governance reads keep unknown/typoed and empty-string eventTypes — they
  must match readAll, which admits any string eventType; only genuinely malformed
  rows are dropped. Rows carrying a `recordKind` belong to another record family
  and are ignored here; the legacy parser stays strict for its own kind. A probe
  failure disables the lag cache rather than blocking the primary timeline read.
- Targeted-fact recall gathers candidates across the ordered LCM read key set
  (primary overlay, then project/root fallbacks) and unions them into the existing
  rank/dedupe/budget pass, with per-key failure isolation so a corrupt/locked
  fallback index cannot discard the primary key's evidence; routing through the
  unified dedup/score/threshold/sort spine keeps one ranking implementation.
- Taxonomy loading rejects duplicate category IDs before merging (otherwise
  last-write-wins silently collapses them); CJK bigrams tokenize BOTH content and
  filing rules so a CJK taxonomy matches CJK content, with Latin-only taxonomies
  unaffected.

This file also covers the targeted-fact/LCM and taxonomy themes merged in as the
nearest read-path neighbours to respect the ten-file limit.

## Consequences
Full-tree and all-category scans cost I/O on every uncached read; crash-safe spill draining keeps orphan files around until a later drain commits them.

## Origin comments
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:88` — "* * Max bytes of a single ledger row we will decode to a V8 string. A malformed * or truncated row with no newline can"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:99` — "* * Yield ledger lines from a whole-file buffer WITHOUT ever materializing the * entire decrypted body as one V8 strin"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:170` — "* * Compaction-only variant of {@link readAllLifecycleEventsFromLedger} that reads * the ledger through a decrypted BU"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:192` — "* * Bounded tail read: retains at most `limit` rows via a streaming min-heap so * the whole ledger is never materializ"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:296` — "// Probe failure: disable lag cache, do not block the primary timeline read (#2119 review)."
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:418` — "* * Directory holding the durable pending-append spill for a lifecycle ledger * (#2033). When an append cannot acquire"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:435` — "* * Secure IO the pending spill needs. `writeSecure`/`readSecure` mirror the * ledger's own secure write/read so each "
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:477` — "* * Write one spill file (a fresh, uniquely-named, immutable per-append file). * The write goes to the FINAL `<uuid>.j"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:498` — "* * Recover claims a crashed drain left mid-flight (#2033). A crash-safe drain * renames `*.jsonl` \u2192 `*.jsonl.claimed`"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:520` — "* Max bytes of pending-spill content folded into one append (#2033). The drain * reads and concatenates at most this m"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:529` — "* * Claim ONE bounded batch of spills for commit via a CRASH-SAFE rename (#2033). * Content is read LAZILY here \u2014 at e"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:558` — "// Read at the ORIGINAL (AAD-bound) path BEFORE claiming. A read failure"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:559` — "// propagates with the file untouched, so it stays for a later retry."
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:562` — "// Stop before a spill that would overflow a non-empty batch so peak memory"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:563` — "// and the single-append payload stay bounded; it starts the next batch."
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:571` — "// could not claim \u2192 do not commit; a later drain retries it."
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:580` — "* Delete claimed spill files after their rows are durably committed. A delete * that fails leaves an orphan the next d"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:589` — "* Roll a failed commit's claims back to unclaimed `*.jsonl` spills so they are * retried as normal spills (#2033). Bes"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:599` — "* * Under the held ledger lock, fold durable pending spills into the ledger in * bounded batches together with `extraP"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:621` — "// listContainedSpillFiles rejects a symlinked pending dir and skips any"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:622` — "// symlinked/escaping entry BEFORE we secure-read or later unlink it (#2033),"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:623` — "// so a poisoned link cannot redirect a decrypt/delete outside the spill dir."
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:649` — "* * Append `payload` to the lifecycle ledger under the cross-process ledger lock * so it is serialized against compact"
- `packages/remnic-core/src/storage/memory-lifecycle-ledger-access.ts:701` — "* * Drain the durable pending spills into the ledger under the ledger lock WITHOUT * appending a new event (#2033). Ma"
- `packages/remnic-core/src/storage/memory-read-store.ts:255` — "// Scan EVERY supported memory category directory, not just the legacy four"
- `packages/remnic-core/src/storage/memory-read-store.ts:256` — "// (facts/procedures/reasoning-traces/corrections). Issue #1497: the QMD"
- `packages/remnic-core/src/storage/memory-read-store.ts:257` — "// filesystem-fallback recall path (orchestrator `recent_scan` ->"
- `packages/remnic-core/src/storage/memory-read-store.ts:258` — "// readAllMemoriesForNamespaces -> readAllMemories -> here) must read every"
- `packages/remnic-core/src/storage/memory-read-store.ts:259` — "// recall category dir so on-disk memories in preferences/decisions/moments/"
- `packages/remnic-core/src/storage/memory-read-store.ts:260` — "// commitments/principles/rules/skills/relationships are not missed when QMD"
- `packages/remnic-core/src/storage/memory-read-store.ts:261` — "// is disabled, missing, or unhealthy. RECALL_FALLBACK_DIRS is the single"
- `packages/remnic-core/src/storage/memory-read-store.ts:262` — "// source of truth derived from ALL_CATEGORY_DIRS (shared with"
- `packages/remnic-core/src/storage/memory-read-store.ts:263` — "// ensureDirectories() and the write routing in utils/category-dir.ts)."
- `packages/remnic-core/src/storage/memory-read-store.ts:264` — "// These paths resolve identically to the legacy this.deps.factsDir /"
- `packages/remnic-core/src/storage/memory-read-store.ts:265` — "// this.deps.correctionsDir / this.deps.proceduresDir / this.deps.reasoningTracesDir"
- `packages/remnic-core/src/storage/memory-read-store.ts:266` — "// getters (all `path.join(this.deps.baseDir, <dir>)`), so the scan stays"
- `packages/remnic-core/src/storage/memory-read-store.ts:267` — "// namespace-aware: this.deps.baseDir is per-namespace, set by the storage router."
- `packages/remnic-core/src/storage/memory-read-store.ts:268` — "// Deliberately EXCLUDED (issue #1497 + PR #1503 review): the non-category"
- `packages/remnic-core/src/storage/memory-read-store.ts:269` — "// content dirs that ensureDirectories() also creates \u2014 entities/, state/,"
- `packages/remnic-core/src/storage/memory-read-store.ts:270` — "// artifacts/, identity/, config/ \u2014 plus the root profile.md, AND the"
- `packages/remnic-core/src/storage/memory-read-store.ts:271` — "// questions/ queue dir. questions/ holds operational question-QUEUE items"
- `packages/remnic-core/src/storage/memory-read-store.ts:272` — "// written by writeQuestion() (frontmatter `{ id, created, priority,"
- `packages/remnic-core/src/storage/memory-read-store.ts:273` — "// resolved }`), read only via readQuestions() and surfaced through the"
- `packages/remnic-core/src/storage/memory-read-store.ts:274` — "// dedicated, disabled-by-default `injectQuestions` recall-pipeline stage \u2014"
- `packages/remnic-core/src/storage/memory-read-store.ts:275` — "// never as standard recall memories. The QMD primary recall corpus does not"
- `packages/remnic-core/src/storage/memory-read-store.ts:276` — "// include them, so the fallback must not either (corpus parity; CLAUDE.md"
- `packages/remnic-core/src/storage/memory-read-store.ts:277` — "// rule #39). Were questions/ scanned here, parseFrontmatter() would accept"
- `packages/remnic-core/src/storage/memory-read-store.ts:278` — "// those files (they have a `---` frontmatter block) and leak queue items"
- `packages/remnic-core/src/storage/memory-read-store.ts:279` — "// into recall. None of these excluded dirs are in RECALL_FALLBACK_DIRS; the"
- `packages/remnic-core/src/storage/memory-read-store.ts:280` — "// exclusion is asserted by tests in storage-fallback-category-dirs.test.ts."
- `packages/remnic-core/src/storage/memory-read-store.ts:374` — "* * Read all memories from the cold tier by scanning the entire cold/ root * tree. Previously this only scanned cold/f"
- `packages/remnic-core/src/storage/memory-read-store.ts:405` — "// Read the on-disk cold-version sentinel BEFORE checking the cache so that"
- `packages/remnic-core/src/storage/memory-read-store.ts:406` — "// writes made by other processes (gateway + CLI) are detected immediately."
- `packages/remnic-core/src/storage/memory-read-store.ts:407` — "// Finding UvUy (PR #402 round-11): without this check the cache served"
- `packages/remnic-core/src/storage/memory-read-store.ts:408` — "// stale data for up to 30s when another process wrote a new cold memory."
- `packages/remnic-core/src/storage/memory-read-store.ts:411` — "// Return cached result if still valid by TTL, sentinel version, AND the"
- `packages/remnic-core/src/storage/memory-read-store.ts:412` — "// secure-store key identity (issue #1902). readParsedMemoriesFromPaths"
- `packages/remnic-core/src/storage/memory-read-store.ts:413` — "// decrypts per this manager's key, so a differently-keyed manager must not"
- `packages/remnic-core/src/storage/memory-read-store.ts:414` — "// read a cold corpus another instance decrypted for the same coldRoot."
- `packages/remnic-core/src/storage/memory-read-store.ts:449` — "// Scan the entire cold root so that memories in any subdirectory (facts/,"
- `packages/remnic-core/src/storage/memory-read-store.ts:450` — "// corrections/, artifacts/, or any future category-specific subdirectory)"
- `packages/remnic-core/src/storage/memory-read-store.ts:451` — "// are included. This is broader than the previous facts/+corrections/ scan"
- `packages/remnic-core/src/storage/memory-read-store.ts:452` — "// and ensures that any memory with structuredAttributes is found regardless"
- `packages/remnic-core/src/storage/memory-read-store.ts:453` — "// of which category it was written with."
- `packages/remnic-core/src/storage/memory-read-store.ts:457` — "// Store in cache with the sentinel version captured above so that any"
- `packages/remnic-core/src/storage/memory-read-store.ts:458` — "// subsequent cold-version bump (by this or another process) invalidates it."
- `packages/remnic-core/src/storage/memory-read-store.ts:459` — "// A raw-free read stays out of the cache so it cannot evict the raw copy."
- `packages/remnic-core/src/storage/secure-line-reader.test.ts:53` — "// Unknown/typoed and empty-string eventTypes are structurally valid, so the"
- `packages/remnic-core/src/storage/secure-line-reader.test.ts:54` — "// bounded governance read MUST keep them \u2014 it has to match readAll, which"
- `packages/remnic-core/src/storage/secure-line-reader.test.ts:55` — "// admits any string eventType. Only genuinely malformed rows are dropped."
- `packages/remnic-core/src/storage/secure-line-reader.test.ts:127` — "// The remedy is namespace-aware (#2033): an oversized encrypted ledger"
- `packages/remnic-core/src/storage/secure-line-reader.test.ts:128` — "// under namespaces/<ns>/state must not be pointed at a root-only command."
- `packages/remnic-core/src/storage/secure-line-reader.test.ts:150` — "// No maxDecryptBytes argument: the caller (e.g. the memory-actions ledger)"
- `packages/remnic-core/src/storage/secure-line-reader.test.ts:151` — "// has no compaction remedy, so the size guard must NOT fire \u2014 decryption is"
- `packages/remnic-core/src/storage/secure-line-reader.test.ts:152` — "// attempted exactly as before the lifecycle-only ceiling was added."
- `packages/remnic-core/src/storage/secure-line-reader.ts:9` — "* * Whole-file decrypt ceiling for encrypted state files. V8's max string length * is ~512MB; a decrypted body that ap"
- `packages/remnic-core/src/storage/secure-line-reader.ts:19` — "* * Stream plaintext files by line while preserving authenticated whole-file * reads for encrypted files. `maxDecryptB"
- `packages/remnic-core/src/storage/secure-line-reader.ts:33` — "// Reject a symlink/FIFO/device BEFORE opening, matching the maintenance ledger"
- `packages/remnic-core/src/storage/secure-line-reader.ts:34` — "// probe (probeEncryptedRegularFileHeader, #2033): opening a FIFO blocks until a"
- `packages/remnic-core/src/storage/secure-line-reader.ts:35` — "// writer appears and a symlink would redirect the read outside our tree. An"
- `packages/remnic-core/src/storage/secure-line-reader.ts:36` — "// ENOENT from the missing regular file propagates so callers keep their"
- `packages/remnic-core/src/storage/secure-line-reader.ts:37` — "// absent-file \u2192 [] behavior (they catch ENOENT), exactly as a missing open did."
- `packages/remnic-core/src/storage/secure-line-reader.ts:94` — "// Ledger discriminated union (#2347): any row carrying a `recordKind`"
- `packages/remnic-core/src/storage/secure-line-reader.ts:95` — "// belongs to another record family (e.g. context_transform) and must"
- `packages/remnic-core/src/storage/secure-line-reader.ts:96` — "// be ignored here \u2014 the legacy parser stays strict for its own kind."
- `packages/remnic-core/src/storage/secure-line-reader.ts:168` — "* * Validate that a parsed row carries every required lifecycle-event field. * Shared by the tail reader and the per-m"
- `packages/remnic-core/src/targeted-fact-recall.ts:21` — "/** * Ordered, read-authorized LCM read key set (primary overlay \u2192 project/root * fallbacks). When present, evidence "
- `packages/remnic-core/src/targeted-fact-recall.ts:58` — "// #1505 codex P2: gather candidates across the ordered LCM read key set"
- `packages/remnic-core/src/targeted-fact-recall.ts:59` — "// (primary overlay \u2192 project/root fallbacks) and UNION them into the existing"
- `packages/remnic-core/src/targeted-fact-recall.ts:60` — "// rank/dedupe/budget pass, so stronger project-fallback evidence is not masked"
- `packages/remnic-core/src/targeted-fact-recall.ts:61` — "// by a weak primary-key hit. `gatherAcrossReadSessions` isolates a per-key read"
- `packages/remnic-core/src/targeted-fact-recall.ts:62` — "// failure so a corrupt/locked fallback index can't discard the primary key's"
- `packages/remnic-core/src/targeted-fact-recall.ts:63` — "// evidence; the single-key path collects exactly one search+scan pair and"
- `packages/remnic-core/src/targeted-fact-recall.ts:64` — "// propagates a failure as before \u2014 byte-for-byte the pre-#1505 behavior."
- `packages/remnic-core/src/targeted-fact-recall.ts:223` — "/** * Issue #1539 PR3: targeted-fact now routes dedup/score/threshold/sort through * the unified spine (`unifiedDedup"
- `packages/remnic-core/src/taxonomy/resolver.ts:152` — "// CJK bigrams tokenize BOTH sides (content and filing rules), so a"
- `packages/remnic-core/src/taxonomy/resolver.ts:153` — "// taxonomy written in a CJK language matches CJK content; Latin-only"
- `packages/remnic-core/src/taxonomy/resolver.ts:154` — "// taxonomies see no change (issue #2192)."
- `packages/remnic-core/src/taxonomy/taxonomy-loader.ts:164` — "// Validate: reject duplicate IDs in user categories before merging."
- `packages/remnic-core/src/taxonomy/taxonomy-loader.ts:165` — "// Without this check, duplicates are silently collapsed with last-write-wins"
- `packages/remnic-core/src/taxonomy/taxonomy-loader.ts:166` — "// semantics when inserted into the Map."
- `packages/remnic-core/src/temporal-index-compat.ts:26` — "// Medium): the sync waiter blocks the Node event loop with sleepSync, so if a"
- `packages/remnic-core/src/temporal-index-compat.ts:27` — "// lock is held by an in-flight async write (awaited I/O) it can't be released"
- `packages/remnic-core/src/temporal-index-compat.ts:28` — "// until the loop runs again. Cap the stall at this bound and fail open rather"
- `packages/remnic-core/src/temporal-index-compat.ts:29` — "// than deadlock or stall for INDEX_LOCK_STALE_MS. 1.5s tolerates a slow disk"
- `packages/remnic-core/src/temporal-index-compat.ts:30` — "// write while bounding the worst-case event-loop freeze."
- `packages/remnic-core/src/temporal-index-compat.ts:168` — "// Node event loop, so an UNBOUNDED wait here would stall the whole process if"
- `packages/remnic-core/src/temporal-index-compat.ts:170` — "// (advisory indexes) rather than risk starving the loop \u2014 e.g. a lock held by"
- `packages/remnic-core/src/temporal-index-compat.ts:171` — "// in-flight async work that needs the very loop this call is blocking."
- `packages/remnic-core/src/temporal-index-compat.ts:239` — "// (issue #1911, Cursor Medium) \u2014 `<temporal>.lock.d` then `<tag>.lock.d`,"
- `packages/remnic-core/src/temporal-index-compat.ts:240` — "// nested in a fixed order (no deadlock: the async surface acquires them one"
- `packages/remnic-core/src/temporal-index-compat.ts:241` — "// at a time, never both). The acquisition is BOUNDED + fail-open"
- `packages/remnic-core/src/temporal-index-compat.ts:242` — "// (withIndexFileLock), so an event-loop-blocking sync waiter can never stall"
- `packages/remnic-core/src/temporal-index-compat.ts:243` — "// the loop waiting on a lock held across an async await \u2014 if the async write"
- `packages/remnic-core/src/temporal-index-compat.ts:244` — "// doesn't release in the bound, sync gives up (advisory indexes fail open)."
- `packages/remnic-core/src/temporal-index-compat.ts:245` — "// Holding both locks together makes the paired write atomic vs. both surfaces."
- `packages/remnic-core/src/temporal-index.test.ts:270` — "// Cursor Medium): committing tags while temporal stays unchanged leaves a"
- `packages/remnic-core/src/temporal-index.test.ts:271` — "// durable mismatch. Both halves stay at their prior state, so \"rejected\" has"
- `packages/remnic-core/src/temporal-index.test.ts:272` — "// no tag membership until a later successful (both-halves) index."
- `packages/remnic-core/src/temporal-index.test.ts:441` — "// temporal lock blocks the temporal write, so the tag half is also skipped"
- `packages/remnic-core/src/temporal-index.test.ts:442` — "// (no durable mismatch). The tag index is never created \u2192 query returns null."
- `packages/remnic-core/src/temporal-index.ts:125` — "// a single logical index mutation touches TWO files (temporal + tag), each with"
- `packages/remnic-core/src/temporal-index.ts:126` — "// its own per-file writeChain. Without an outer lock, two overlapping"
- `packages/remnic-core/src/temporal-index.ts:127` — "// indexMemoryAsync calls could interleave so the temporal half of one commits"
- `packages/remnic-core/src/temporal-index.ts:128` — "// with the tag half of the other. This chain makes each public mutator's paired"
- `packages/remnic-core/src/temporal-index.ts:129` — "// writes atomic relative to other mutators on the same memoryDir."
- `packages/remnic-core/src/temporal-index.ts:267` — "// hardcoding true let deindexMemoryAsync (which does not bump version) cache"
- `packages/remnic-core/src/temporal-index.ts:268` — "// an old-schema index as current, so indexesExistAsync then skipped a"
- `packages/remnic-core/src/temporal-index.ts:269` — "// needed rebuild. The tag index is always current (no version gate); the"
- `packages/remnic-core/src/temporal-index.ts:270` — "// temporal index is current only when hasCurrentTemporalIndexSchema holds."
- `packages/remnic-core/src/temporal-index.ts:446` — "// exceptions so a test hook can never turn a successful write into a"
- `packages/remnic-core/src/temporal-index.ts:447` — "// retry or a false (failed) result, which would clear the cache and"
- `packages/remnic-core/src/temporal-index.ts:448` — "// skip the paired tag-index phase."
- `packages/remnic-core/src/temporal-index.ts:953` — "// the tag half (issue #1911, Cursor Medium) \u2014 committing tags while"
- `packages/remnic-core/src/temporal-index.ts:954` — "// temporal stays unchanged leaves a durable mismatch until a later index."
- `packages/remnic-core/src/temporal-index.ts:1173` — "// both chronology edges so earliest and latest questions remain answerable."
- `packages/remnic-core/src/temporal-index.ts:1375` — "// as fromDate so the window isn't unbounded. toDate is set to the month start"
- `packages/remnic-core/src/temporal-index.ts:1376` — "// in recencyWindowBoundsFromPrompt."
- `packages/remnic-core/src/temporal-index.ts:1377` — "// IMPORTANT: when an explicit year is given, anchor the lookback to the named"
- `packages/remnic-core/src/temporal-index.ts:1378` — "// month start (not to today). \"before January 2024\" should produce"
- `packages/remnic-core/src/temporal-index.ts:1379` — "// fromDate \u2248 2022-01 \u2014 not today-730 days, which could land after 2024-01 and"
- `packages/remnic-core/src/temporal-index.ts:1380` — "// invert the window for any explicitly past month within the 730-day horizon."
- `packages/remnic-core/src/temporal-index.ts:1489` — "// month name \u2192 early set (highest priority), then ago patterns set a"
- `packages/remnic-core/src/temporal-index.ts:1490` — "// working offset, then ISO/US/weekday patterns run AFTER ago patterns"
- `packages/remnic-core/src/temporal-index.ts:1491` — "// and can override them \u2014 matching the priority ordering in recencyWindowFromPrompt."
- `packages/remnic-core/src/temporal-index.ts:1558` — "// and override the ago-derived offset when present."
- `packages/remnic-core/src/temporal-index.ts:1595` — "// an empty window. Using `today` is insufficient because `date < today` excludes today."
