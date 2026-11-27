# A disk-backed corpus version sentinel plus identity-validated caches keep every read coherent across processes, encryption-key changes, and concurrent scans

Status: accepted

## Context

Multiple processes (daemon, CLI, drains) share one memory corpus with layered in-memory caches. Without a shared invalidation signal, warm caches serve pre-write corpora; without identity validation, caches survive file rewrites or encryption flips that their stale entries no longer describe.

## Decision

Every memory-FILE mutation bumps the corpus version sentinel on disk (single-byte exclusive write: exclusive iff exactly our byte landed between the two stats); peer processes compare it before serving from the hot cache and rescan on change. Status-only changes bump the memory-status epoch separately because a corpus bump does not cover them. Bulk/ambiguous mutations drop the hot layer wholesale. The sentinel is activated at setup so the hot path engages on read-heavy workloads, and out-of-band writers (review approvals, space copies) bump it per written file, on the canonical root, so warm caches rescan mid-batch.

In-flight corpus scans snapshot BOTH the corpus version and the secure-store key identity once before reading; they publish to cache only if neither changed during the scan (a mid-await key rotation or peer write invalidates the result). Patches to the hot cache bump the sentinel and drop the in-flight slot BEFORE the awaited re-read, then re-read and re-parse the one just-written file, re-keying the patched entry to the new version; an unparseable patch leaves the entry evicted rather than trusted.

A joiner never cancels a shared in-flight scan, but refcounting stops the scan once the last waiter leaves, and a starter that aborts is removed from the registry first so a late joiner cannot inherit its AbortError; cancellation is re-checked per batch and once more after the loop. Raw-free reads neither join nor publish the shared cache. Namespace routers propagate the cache-enabled gate to children (no silent fall back to the process-wide default), per-dir TTL/cache settings are registered without flipping earlier dirs, and a falsy-but-valid empty corpus result is null-checked, not truthiness-checked. Directory mtime is only a cross-process hint; same-process resolution invalidates directly. Non-namedspace state writes (lifecycle ledger appends) never touch the namespace catalog. Tombstone caches are scoped to the ledger revision with a staleness probe on cached hits. The lazy snapshot format avoids building a whole-corpus key-sorted JSON blob on load.

## Consequences

Every out-of-band write path must remember to bump the sentinel or it introduces staleness; identity validation (size+mtime) is a heuristic that a sufficiently fast same-size rewrite can defeat within a scan window.

## Origin comments

- `packages/remnic-core/src/storage-catalog-touch-gating.test.ts:1` — "/** * Issue #1903 — state-file writes must not touch the namespace catalog. * * The post-write catalog hook (`"
- `packages/remnic-core/src/storage-catalog-touch-gating.test.ts:44` — "// A namespace-data write (facts/) MUST touch exactly once. The lifecycle"
- `packages/remnic-core/src/storage-catalog-touch-gating.test.ts:45` — "// ledger append it also performs is a state write and stays excluded."
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:165` — "// Simulate a peer process advancing the on-disk corpus sentinel (its byte"
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:166` — "// size IS the version). This instance's warm entry is now stale-versioned."
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:238` — "// Register divergent per-dir settings; a later registration must NOT flip"
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:239` — "// an earlier dir's behavior (the \"last orchestrator wins\" bug)."
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:242` — "// Constructed WITHOUT a per-instance override, so each resolves its own"
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:243` — "// dir's registered default."
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:286` — "// Cross-process: the shared sentinel advanced so peer processes rescan and"
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:287` — "// never overwrite this process's increment (Codex P2)."
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:308` — "// The daemon calls ensureDirectories() at startup (before serving reads); it"
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:309` — "// seeds a nonzero sentinel so the hot path engages on a read-heavy workload."
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:335` — "// getCachedMemories returns [] (falsy) for an empty corpus; the read guard"
- `packages/remnic-core/src/storage-contract/cache-coherence.test.ts:336` — "// must null-check, not truthiness-check, or every read rescans."
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:1` — "/** * Issue #2307 — the shared full-corpus read primitives honour cancellation. * * Scenario matrix, applied t"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:51` — "/** * Hold the first disk scan open so a joiner provably attaches while it is in * flight, and guarantee teard"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:112` — "// Abort once the walk has produced paths: the next per-batch checkpoint in the"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:113` — "// parse phase is a real boundary, not a synthetic one."
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:127` — "// The publish step is downstream of the checkpoint, so a truncated corpus must"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:128` — "// never have reached the cache: a fresh read has to scan again."
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:146` — "// Observe the starter now: its rejection lands the instant it aborts, and this"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:147` — "// test awaits the joiner in between, so an unobserved promise would surface as"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:148` — "// an unhandled rejection rather than the assertion below."
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:165` — "// The joiner keeps the scan alive, so it completes — but the starter still"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:166` — "// gets its own AbortError, because it asked to be cancelled."
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:183` — "// The starter's scan is doomed the instant its signal fires while it is the"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:184` — "// sole waiter. Withdrawing it from the registry first is what stops a late"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:185` — "// joiner inheriting that AbortError for a request it never cancelled."
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:193` — "// Joins only AFTER the abort — must not attach to the doomed scan."
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:244` — "// Two cancellable readers overlap and both give up. Neither may cancel alone,"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:245` — "// but with nobody left the scan must not run on for no one — that is the"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:246` — "// abandoned I/O this whole change removes."
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:255` — "// First to leave must NOT cancel: the other reader still wants the result."
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:327` — "// Abort once the first entity file has been read: the post-loop checkpoint is"
- `packages/remnic-core/src/storage-contract/corpus-read-cancellation.test.ts:328` — "// what stops that partial batch reaching setCachedEntities."
- `packages/remnic-core/src/storage-contract/lazy-memory-snapshot.test.ts:1` — "/** * COS-666d: loading the corpus built a key-sorted JSON snapshot of every memory * (`createMemorySnapshot`)"
- `packages/remnic-core/src/storage-contract/lazy-memory-snapshot.test.ts:105` — "// A handcrafted object has no retained raw document and was never loaded: the old fallback"
- `packages/remnic-core/src/storage-contract/lazy-memory-snapshot.test.ts:106` — "// compares `frontmatter.updated` only, so the same state moves and a changed one is refused."
- `packages/remnic-core/src/storage-contract/namespace-routing.test.ts:148` — "// Gate propagated to the child: with caching disabled the child storage"
- `packages/remnic-core/src/storage-contract/namespace-routing.test.ts:149` — "// never populates the module-level hot cache, so getCachedMemories stays"
- `packages/remnic-core/src/storage-contract/namespace-routing.test.ts:150` — "// null even after reads. Before the fix the child fell back to the"
- `packages/remnic-core/src/storage-contract/namespace-routing.test.ts:151` — "// process-wide default (true) and would have cached the corpus."
- `packages/remnic-core/src/storage-contract/round-trip.test.ts:399` — "// Directory mtimes are only a cross-process hint and may be coarser than"
- `packages/remnic-core/src/storage-contract/round-trip.test.ts:400` — "// the cache timestamp. Same-process resolution must invalidate directly."
- `packages/remnic-core/src/storage.ts:1771` — "// Corpus version sentinel (issue #1902): bumped on every memory-FILE mutation"
- `packages/remnic-core/src/storage.ts:1781` — "// In-process fallback for the cold-write sentinel (used when the disk file"
- `packages/remnic-core/src/storage.ts:1847` — "// Module-level maps for readAllMemories() keyed by base directory, shared"
- `packages/remnic-core/src/storage.ts:1851` — "// Cache for readAllColdMemories() — keyed by cold root directory path."
- `packages/remnic-core/src/storage.ts:1867` — "// Cache for readQuestions() — avoids serially re-reading tens of thousands of"
- `packages/remnic-core/src/storage.ts:1905` — "/** * Cache of \"is this file encrypted?\" keyed by absolute path, VALIDATED by file * identity (size + mtimeMs) — issue"
- `packages/remnic-core/src/storage.ts:2258` — "// Register per-dir so each orchestrator's config reaches every"
- `packages/remnic-core/src/storage.ts:2262` — "// TTL safety net: a finite, non-negative override wins (0 honored = disable)."
- `packages/remnic-core/src/storage.ts:2269` — "// Seed the process-wide fallbacks (for UNregistered dirs) ONCE, from the"
- `packages/remnic-core/src/storage.ts:2392` — "// Corpus sentinel too: peer processes rescan the hot-memories cache"
- `packages/remnic-core/src/storage.ts:2396` — "// Invalidation chokepoint (#1535): several status/entity mutations"
- `packages/remnic-core/src/storage.ts:2460` — "// Exclusive iff exactly our single byte landed between the two stats."
- `packages/remnic-core/src/storage.ts:2698` — "// No manual sniff-cache update needed (issue #1909 round 10): this rewrite"
- `packages/remnic-core/src/storage.ts:2969` — "// Header-only sniff (issue #1909): reads at most MAGIC_HEADER_SIZE bytes"
- `packages/remnic-core/src/storage.ts:2983` — "// Plaintext append does not touch the header. isEncryptedFileHeader is now"
- `packages/remnic-core/src/storage.ts:3056` — "// Corpus-path + source-content caches are scoped to one ledger revision"
- `packages/remnic-core/src/storage.ts:3089` — "// The store owns the staleness probe + reload (#1579): on a cached hit it"
- `packages/remnic-core/src/storage.ts:3655` — "// Activate the corpus sentinel at setup (issue #1902, Cursor Medium): an"
- `packages/remnic-core/src/storage.ts:4251` — "// Always invalidate on write. This avoids stale mixed snapshots when multiple"
- `packages/remnic-core/src/storage.ts:4371` — "// A raw-free read must not join or publish the shared cache: those entries"
- `packages/remnic-core/src/storage.ts:4384` — "// Snapshot the secure-store key identity ONCE (issue #1902, Codex Medium):"
- `packages/remnic-core/src/storage.ts:4394` — "// A joiner never cancels the shared scan on its own, but it does stop waiting"
- `packages/remnic-core/src/storage.ts:4412` — "// Publish only if neither the corpus version NOR the key identity changed"
- `packages/remnic-core/src/storage.ts:4425` — "// The starter races its own signal too. Refcounting means a sole waiter's"
- `packages/remnic-core/src/storage.ts:4504` — "// Bulk/ambiguous mutations drop the hot layer wholesale (below); bump the"
- `packages/remnic-core/src/storage.ts:4508` — "// Invalidation chokepoint (issue #1535 / #1904): evict the layers a"
- `packages/remnic-core/src/storage.ts:4523` — "// Issue #1579 — tombstone store is a cache layer too (rule 25: clear ALL"
- `packages/remnic-core/src/storage.ts:4556` — "// Snapshot the key identity once (issue #1902, Codex Medium): a mid-await"
- `packages/remnic-core/src/storage.ts:4566` — "// Bump the corpus sentinel AND drop the in-flight slot BEFORE the awaited"
- `packages/remnic-core/src/storage.ts:4578` — "// Re-read + parse the ONE just-written file so the cached object is"
- `packages/remnic-core/src/storage.ts:4584` — "// Best-effort re-parse: this cache patch runs AFTER the on-disk write and"
- `packages/remnic-core/src/storage.ts:4601` — "// Could not re-parse the write — don't trust the patched entry; leaving"
- `packages/remnic-core/src/storage.ts:4614` — "// Re-key the patched entry (still tagged prevVersion) to the version THIS"
- `packages/remnic-core/src/storage.ts:4624` — "// Evict the non-hot layers; the hot layer is patched (or intentionally left"
- `packages/remnic-core/src/storage.ts:4660` — "// Invalidation chokepoint (issue #1535): cold-tier mutations can reach"
- `packages/remnic-core/src/storage.ts:4729` — "// Per batch: the parse phase is as long as the walk on a large corpus, and"
- `packages/remnic-core/src/storage.ts:4762` — "// Once more after the loop: a signal that fired during the LAST batch's await"
- `packages/remnic-core/src/storage.ts:4844` — "// Per batch: an abandoned caller must not keep the scan running (#3139)."
- `packages/remnic-core/src/storage.ts:5446` — "// Status change bumps memory-status; a corpus bump does not cover it (#1902)."
- `packages/remnic-core/src/storage.ts:6530` — "// Corpus version and warmth are snapshotted before the writes (#1902)."
- `packages/remnic-core/src/storage.ts:6533` — "// Snapshot the secure-store key identity once (Cursor Medium #1902), mirroring"
- `packages/remnic-core/src/storage.ts:6541` — "// Record each applied patch so the end-of-flush re-key can re-apply them on"
- `packages/remnic-core/src/storage.ts:6590` — "// Advance the corpus sentinel so peers rescan (#1902). Re-key local patches"
- `packages/remnic-core/src/storage.ts:6595` — "// Drop the in-flight read slot after the bump (parity with"
- `packages/remnic-core/src/storage.ts:6611` — "// Re-apply our patches on top of whatever is cached at prevVersion"
- `packages/remnic-core/src/storage.ts:6630` — "// Evict the derived (episode/rule) + global (QMD recall/search) layers,"
- `packages/remnic-core/src/storage.ts:7189` — "// Corpus bump before the lifecycle append (#1902). Epoch moves only if repair changed entityRef or origin."
