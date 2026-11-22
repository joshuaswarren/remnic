# Orchestrator persistence paths are durable-first and fail in defined directions: buffered turns land before any wait that could abandon them, committed batch facts survive sibling-branch failures, dedup reads from one corpus-authoritative index, and metadata/ancillary failures never reject the primary result.

Status: accepted

## Context
Extraction batches, drains, and shutdown interleave durable writes with cleanup and bookkeeping; naive ordering lost buffered turns on kill, dropped already-durable facts when a sibling branch threw, or let a stale side-index resurrect duplicates.

## Decision
Flush/shutdown ordering: a metadata write failure during session flush is diagnostic only - it must neither reject the task nor retain the buffer (extraction succeeded and produced nothing durable). Persist unsent turns BEFORE the extraction drain and before any long fact-hash warm-up wait, because shutdown abandons or bounds the drain and a kill during the wait would lose them. The destroyed flag flips only AFTER the drain, since an extraction in its persist stage reads dependencyPropagationDelivery. Post-drain removals persist with failed writes left pending for next boot.

Batch finalization: a branch that throws after an earlier fact in the same batch is durable must still land that earlier fact - finalization starts the temporal/tag update without awaiting it and cleanup waits so the temp dir is not removed under its lock. Merged-target post-effects fail open for the graph rebuild, but the edge-cache invalidation that follows is intentionally not wrapped: an unavailable graph index escapes after the merge committed.

Dedup and hashes: the orchestrator shares the StorageManager's corpus-authoritative fact-hash index (rebuilt from the .md corpus per process) instead of a separate possibly-stale file, making dedup and hasFactContentHash one coherent source - a crash before the deferred batch save still yields a restart rebuild that includes the durable fact, so persistExtraction does not re-create it. The shared best-effort accessor (never the throwing one) must stay available for registration under lock contention; the dedup read path gates a MISS on authoritativeness and confirms against the corpus, so a non-authoritative snapshot never causes a false miss.

Related contracts: citations are canonicalized on the raw body before hashing so relayed facts dedup against the original write, and raw bodies stay untouched for existing consumers; stripCitation is intentionally not applied to the legacy archive path (skip-with-warning instead); per-fact start-bound (valid_at) anchoring is carried onto existing copies on re-extraction; tombstone non-resurrection funnels every write path through the chokepoint (router storages inherit via bindTombstonesConfig); namespace catalog touches are best-effort and never affect storage resolution, but registration resolves only after the catalog actually APPENDED so a dropped append retries.

Background jobs: collection-level embed drains reschedule when writes appended during the flight; the prioritized-embed timer is unref'd so short-lived CLIs exit; profiling prune is single-flight and trace state is keyed per traceId; storage dirs are created lazily on first persist so discovery/registration passes never touch the memory dir; patterns CLI sorts guard NaN timestamps (invalid = oldest) and Markdown table escaping processes backslashes first.

## Consequences
Fail-open/fail-closed choices are per-path and deliberate (graph rebuild fails open, invalidation propagates) - changing one without the other reintroduces the original loss windows; best-effort metadata means diagnostics may understate state after failures.

> Note: this file merges smaller neighbouring themes that did not warrant their own ADR under the ten-file limit for this chunk.

## Origin comments
(79 records)
- `packages/remnic-core/src/orchestrator-flush.test.ts:2099` - "// diagnostic only, so a metadata write failure must neither reject the task"
- `packages/remnic-core/src/orchestrator-flush.test.ts:2100` - "// nor retain the buffer — extraction succeeded and produced nothing durable."
- `packages/remnic-core/src/orchestrator-flush.test.ts:2329` - "// The counters and fingerprint land on a FRESHLY loaded meta (the serialized"
- `packages/remnic-core/src/orchestrator-flush.test.ts:2330` - "// updateMeta re-read), so more than one load is expected; the single save is"
- `packages/remnic-core/src/orchestrator-flush.test.ts:2331` - "// the coherent-write contract under test."
- `packages/remnic-core/src/orchestrator-nonchunked-hash-durability.test.ts:1` - "/** * PR #2016 regression: non-chunked parent fact-hash durability. * * Sibling to orchestrator-chunked-hash-d"
- `packages/remnic-core/src/orchestrator-persist-branch-failure.test.ts:17` - "/** * #3288: a branch that throws after an earlier fact in the same batch is * durable must still land that fa"
- `packages/remnic-core/src/orchestrator-persist-branch-failure.test.ts:33` - "/** * Proves the failing branch had already committed its own write when it * threw and returns that write's i"
- `packages/remnic-core/src/orchestrator-persist-branch-failure.test.ts:55` - "// Finalization starts the temporal/tag update without awaiting it; cleanup"
- `packages/remnic-core/src/orchestrator-persist-branch-failure.test.ts:56` - "// waits for it so the temp dir is not removed under its lock."
- `packages/remnic-core/src/orchestrator-persist-branch-failure.test.ts:226` - "// The merged-target graph rebuild fails open, but the edge-cache"
- `packages/remnic-core/src/orchestrator-persist-branch-failure.test.ts:227` - "// invalidation that follows it is not wrapped: an unavailable graph"
- `packages/remnic-core/src/orchestrator-persist-branch-failure.test.ts:228` - "// index escapes runMergedTargetPostEffects after the merge committed."
- `packages/remnic-core/src/orchestrator-source-attribution.test.ts:18` - "/** * Issue #369 — Orchestrator-level source attribution end-to-end. * * These tests call persistExtraction di"
- `packages/remnic-core/src/orchestrator-source-attribution.test.ts:88` - "// Raw body must be untouched for existing downstream consumers."
- `packages/remnic-core/src/orchestrator-source-attribution.test.ts:626` - "// When a fact arrives with an existing citation (e.g. relayed from another"
- `packages/remnic-core/src/orchestrator-source-attribution.test.ts:627` - "// system), the dedup check must canonicalize to the raw body BEFORE hashing"
- `packages/remnic-core/src/orchestrator-source-attribution.test.ts:628` - "// so it matches the entry stored from the original write."
- `packages/remnic-core/src/orchestrator.ts:70` - "// stripCitation (default-format only) is intentionally NOT used on the"
- `packages/remnic-core/src/orchestrator.ts:71` - "// legacy archive path — replaced by skip-with-warning (Finding 2 — Urgw)."
- `packages/remnic-core/src/orchestrator.ts:771` - "/** One breaker per orchestrator: foreground and every isolated claim-backed * drain accumulate toward the same thr"
- `packages/remnic-core/src/orchestrator.ts:780` - "/** The run-coordinator deps bundle, parameterized by its buffer accessor: * an isolated claim-backed drain binds i"
- `packages/remnic-core/src/orchestrator.ts:831` - "/** An extraction run coordinator bound to `buffer` — per drain task, so a * claim-backed drain never shares the li"
- `packages/remnic-core/src/orchestrator.ts:1383` - "// Round 12: share the StorageManager's corpus-AUTHORITATIVE fact-hash index"
- `packages/remnic-core/src/orchestrator.ts:1384` - "// (rebuilt from the .md corpus on first use per process) instead of loading a"
- `packages/remnic-core/src/orchestrator.ts:1385` - "// separate, possibly-stale fact-hashes.txt. This makes the orchestrator's"
- `packages/remnic-core/src/orchestrator.ts:1386` - "// dedup layer and StorageManager.hasFactContentHash() one coherent source:"
- `packages/remnic-core/src/orchestrator.ts:1387` - "// after a crash before the deferred batch save, the restart rebuild includes"
- `packages/remnic-core/src/orchestrator.ts:1388` - "// the durable fact, so hasContentHashDedup() sees it and persistExtraction"
- `packages/remnic-core/src/orchestrator.ts:1389` - "// does not re-create it. We still cache the reference so saveContentHashIndexes"
- `packages/remnic-core/src/orchestrator.ts:1390` - "// persists exactly the shared instance."
- `packages/remnic-core/src/orchestrator.ts:1391` - "// PR #2016: use the shared (best-effort) accessor, not the throwing"
- `packages/remnic-core/src/orchestrator.ts:1392` - "// authoritative one — the shared instance must be available for registration"
- `packages/remnic-core/src/orchestrator.ts:1393` - "// add/remove even under lock contention (it reconciles to disk via the"
- `packages/remnic-core/src/orchestrator.ts:1394` - "// deferred retry). The dedup READ path (extraction-persist) gates a MISS on"
- `packages/remnic-core/src/orchestrator.ts:1395` - "// isFactContentHashAuthoritative() and confirms against the corpus, so a"
- `packages/remnic-core/src/orchestrator.ts:1396` - "// non-authoritative snapshot never causes a false dedup miss."
- `packages/remnic-core/src/orchestrator.ts:1443` - "// #1707 thread 2 — per-fact start bound (valid_at). Carried so a"
- `packages/remnic-core/src/orchestrator.ts:1444` - "// re-extracted duplicate whose event time yields only a start bound"
- `packages/remnic-core/src/orchestrator.ts:1445` - "// ("since 2024", "yesterday", an absolute date) gets the corrected"
- `packages/remnic-core/src/orchestrator.ts:1446` - "// per-fact anchoring onto the existing copy."
- `packages/remnic-core/src/orchestrator.ts:1491` - "// Namespace catalog (issue #1499): downstream, rebuildable metadata index."
- `packages/remnic-core/src/orchestrator.ts:1492` - "// Inert unless namespacesEnabled is true. Storage resolution registers"
- `packages/remnic-core/src/orchestrator.ts:1493` - "// namespaces via the router's onResolve hook; the touch is best-effort and"
- `packages/remnic-core/src/orchestrator.ts:1494` - "// a catalog write failure never affects storage resolution."
- `packages/remnic-core/src/orchestrator.ts:1497` - "// Return the registration promise (round 6, codex P2 — NEFoX) so the"
- `packages/remnic-core/src/orchestrator.ts:1498` - "// router's resolve-hook dedup only marks a namespace notified when the"
- `packages/remnic-core/src/orchestrator.ts:1499` - "// catalog actually APPENDED. A dropped append (rebuild-lock timeout) or a"
- `packages/remnic-core/src/orchestrator.ts:1500` - "// failure resolves to `false`/rejects, so the next `storageFor` retries."
- `packages/remnic-core/src/orchestrator.ts:1522` - "// Wire the tombstone non-resurrection invariant (issue #1579) on the"
- `packages/remnic-core/src/orchestrator.ts:1523` - "// primary default-namespace storage. Router-created namespace storages"
- `packages/remnic-core/src/orchestrator.ts:1524` - "// get the same config via NamespaceStorageRouter.bindTombstonesConfig"
- `packages/remnic-core/src/orchestrator.ts:1525` - "// (installed below) so every write path funnels through the chokepoint."
- `packages/remnic-core/src/orchestrator.ts:3241` - "/** * Append persisted ids to the thread episode set, excluding pending_review * fact ids (#1635) so they don't re-"
- `packages/remnic-core/src/orchestrator.ts:3868` - "/** * #1645: Complete the deferred contradiction auto-resolve after writeMemory * returns and the new write's tombs"
- `packages/remnic-core/src/orchestrator.ts:3929` - "/** * Public best-effort catalog write touch (issue #1499). User-facing explicit * captures (`memory_store`) and re"
- `packages/remnic-core/src/patterns-cli.ts:254` - "// Guard NaN: malformed date strings make Date.parse return NaN, which"
- `packages/remnic-core/src/patterns-cli.ts:255` - "// breaks the sort contract (NaN comparator return == non-deterministic"
- `packages/remnic-core/src/patterns-cli.ts:256` - "// ordering). Treat invalid/missing timestamps as 0 (oldest possible)."
- `packages/remnic-core/src/patterns-cli.ts:369` - "// Guard NaN: same rationale as collectPatternMemories sort — malformed"
- `packages/remnic-core/src/patterns-cli.ts:370` - "// supersededAt strings must not produce a NaN return from the comparator."
- `packages/remnic-core/src/patterns-cli.ts:563` - "/** * Escape characters that would break a Markdown table cell: * - backslashes first (so the `\|` escape below isn't"
- `packages/remnic-core/src/prioritized-embed.ts:37` - "// Do not keep the process alive for the flush delay — short-lived CLI"
- `packages/remnic-core/src/prioritized-embed.ts:38` - "// and import commands must exit promptly (review thread: timer unref)."
- `packages/remnic-core/src/prioritized-embed.ts:67` - "// Collection-level embed drains the entire backlog. If new writes"
- `packages/remnic-core/src/prioritized-embed.ts:68` - "// were appended to the tail while the embed was in flight, reschedule"
- `packages/remnic-core/src/prioritized-embed.ts:69` - "// so they get picked up; otherwise clear the queue."
- `packages/remnic-core/src/profiling.test.ts:102` - "Two steps with a real event-loop turn between them, so the 5ms member's continuation"
- `packages/remnic-core/src/profiling.test.ts:103` - "reads the clock at 5ms instead of after the whole 30ms has been ticked."
- `packages/remnic-core/src/profiling.test.ts:307` - "Constructing a collector happens on every plugin registration, including"
- `packages/remnic-core/src/profiling.test.ts:308` - "read-only discovery passes, so it must not touch the memory dir."
- `packages/remnic-core/src/profiling.ts:103` - "Active trace state — keyed by traceId so concurrent pipelines are isolated."
- `packages/remnic-core/src/profiling.ts:218` - "Single-flight: if a prune is already running, piggyback on it;"
- `packages/remnic-core/src/profiling.ts:219` - "otherwise start one. This prevents concurrent prunes from racing"
- `packages/remnic-core/src/profiling.ts:220` - "on stale directory snapshots."
- `packages/remnic-core/src/profiling.ts:344` - "Created on first persist, never at construction: constructing a"
- `packages/remnic-core/src/profiling.ts:345` - "collector (plugin registration, a discovery pass, CLI metadata) must"
- `packages/remnic-core/src/profiling.ts:346` - "not touch the operator's memory dir when no trace is ever written."
- `packages/remnic-core/src/projection-rebuild-config.ts:1` - "Scheduled projection-rebuild knobs (issue #2119, heap guard). Extracted from `config.ts`…"
