# Offline persistence is additive and folds pending queues before snapshots report success

Status: accepted

## Context
Two persistence layers could silently lose durable state. The warm identity cache for offline manifest walks was overwritten wholesale by overlapping manifest streams, and cache-hostile edges — a partially consumed stream, a file that lost its identity, excluded files, negative parse results — would shrink the cache or force near-cold rebuilds of a large corpus. Separately, appends that time out on a lock spill into offline-sync-EXCLUDED pending directories; a snapshot built without folding them omits the rows, and the data is lost if the node is discarded. Note: this ADR merges the two smallest standalone themes (identity-cache write planning and offline-sync snapshot draining) into one file.

## Decision
- The identity cache lives under the internal `.remnic/` directory, which snapshot enumeration excludes, so cache files never feed back into walks. Identities are fingerprinted to the citation template whose attribution stripping produced them — entries written under a different template would carry wrong content hashes for unchanged files.
- Cache writes are PLANNED: the walk decides what to persist and whether a write is needed at all. ANY change to the persisted set reaches disk — a rebuilt identity, a file that lost its identity, and a completed walk's prune of vanished paths — or the removal is lost forever. A failed read never persists a negative identity for that content hash.
- Cache writes are ADDITIVE: the replacement is seeded with every previously cached entry, so a partially consumed stream (client disconnect, abort) can only add — writing just one run's rebuilds would drop every cache hit and shrink the cache to a single entry. At write time the set is merged with what is on disk NOW (a concurrent stream for the same namespace may have published newer entries after this request loaded its snapshot); a blind whole-file replace would discard them, so replacements are serialized per path. On conflict, the write wins — it reflects the newest walk.
- Excluded files (the walk saw them, the exclusion callback never yielded them) keep their persisted classifications: the next cycle skips the read+parse, and they are kept out of the deleted-path prune. Negative results persist too — a memory-shaped file that parses without an identity would otherwise be re-read on every warm run.
- Offline-sync snapshots FOLD their pending queues before building: rows spilled to the excluded pending directory by a timed-out append are folded into the active file the snapshot carries. The drain is scoped to the snapshot whose root actually contains the file — recall impressions are global (the writer store roots at the configured memory directory), so a namespace-rooted snapshot never drains the writer-root queue (it stays pending for the root sync), while per-namespace lifecycle ledgers drain against the resolved namespace's storage and land in that snapshot.
- When rows cannot be folded (the ledger lock is held by a peer, reported as pending-deferred), every snapshot entrypoint — buffered, streaming, and path enumeration — ABORTS rather than reporting success; a snapshot that silently omits append-only rows is worse than a failed one.

## Consequences
Cache growth is monotonic within a citation template (stale entries need separate pruning); snapshot building can fail under lock contention — surfaced loudly instead of losing rows; exclusion classifications and negative identities consume cache space by design.

## Origin comments
- `packages/remnic-core/src/access-offline-manifest.ts:44` — "/** * Decide what the manifest stream should persist, and whether a write is * needed at all. * * A write is requir"
- `packages/remnic-core/src/access-offline-manifest.ts:60` — "/** Paths the walk saw but never yielded (removed by the exclusion * callback). Not deleted — pruning them would dr"
- `packages/remnic-core/src/access-offline-manifest.ts:75` — "/** * The cache lives under `.remnic/` rather than `state/`: snapshot enumeration * excludes internal `.remnic/` pa"
- `packages/remnic-core/src/access-offline-manifest.ts:99` — "// Identities are derived after stripping inline attribution for a specific"
- `packages/remnic-core/src/access-offline-manifest.ts:100` — "// citation template; entries written under a different one would produce"
- `packages/remnic-core/src/access-offline-manifest.ts:101` — "// wrong contentHash values for unchanged files."
- `packages/remnic-core/src/access-offline-manifest.ts:138` — "/** Serialize cache replacements per path: overlapping manifest streams for one * namespace would otherwise each pu"
- `packages/remnic-core/src/access-offline-manifest.ts:154` — "/** Union of the entries being written and the current on-disk set; on conflict * the write wins (it reflects the n"
- `packages/remnic-core/src/access-offline-manifest.ts:199` — "/** Record classifications for files the walk excluded (the exclusion callback * returned true, so they were never "
- `packages/remnic-core/src/access-offline-manifest.ts:237` — "// The exclusion callback runs before every yield; without the persisted"
- `packages/remnic-core/src/access-offline-manifest.ts:238` — "// classification it would read and parse every candidate file, defeating the"
- `packages/remnic-core/src/access-offline-manifest.ts:239` — "// warm-cache skip entirely."
- `packages/remnic-core/src/access-offline-manifest.ts:255` — "// Any change to the persisted set, not just a rebuilt identity: a file"
- `packages/remnic-core/src/access-offline-manifest.ts:256` — "// that lost its identity, or a completed walk that must prune vanished"
- `packages/remnic-core/src/access-offline-manifest.ts:257` — "// paths, also has to reach disk or the removal is lost forever."
- `packages/remnic-core/src/access-offline-manifest.ts:260` — "// Seeded with every previously cached entry so a partially consumed"
- `packages/remnic-core/src/access-offline-manifest.ts:261` — "// stream (client disconnect, abort) can only add to the cache. Writing"
- `packages/remnic-core/src/access-offline-manifest.ts:262` — "// just this run's rebuilds would drop every cache hit, so one edit to a"
- `packages/remnic-core/src/access-offline-manifest.ts:263` — "// large corpus would shrink the cache to that single entry and force a"
- `packages/remnic-core/src/access-offline-manifest.ts:264` — "// near-cold rebuild on the next request."
- `packages/remnic-core/src/access-offline-manifest.ts:281` — "// Merge with whatever is on disk NOW: a concurrent stream for the"
- `packages/remnic-core/src/access-offline-manifest.ts:282` — "// same namespace may have published newer entries after this"
- `packages/remnic-core/src/access-offline-manifest.ts:283` — "// request loaded its snapshot, and a blind whole-file replace"
- `packages/remnic-core/src/access-offline-manifest.ts:284` — "// would discard them."
- `packages/remnic-core/src/access-offline-manifest.ts:350` — "// Negative results persist too: a memory-shaped file that parses"
- `packages/remnic-core/src/access-offline-manifest.ts:351` — "// without an identity would otherwise be re-read on every warm run."
- `packages/remnic-core/src/access-offline-manifest.ts:357` — "// Read failed: do not persist a negative identity for this SHA."
- `packages/remnic-core/src/access-offline-manifest.ts:376` — "// Files the exclusion callback removed from the snapshot were seen"
- `packages/remnic-core/src/access-offline-manifest.ts:377` — "// this walk but never yielded: persist their classifications so the"
- `packages/remnic-core/src/access-offline-manifest.ts:378` — "// next cycle skips the read+parse, and keep them out of the"
- `packages/remnic-core/src/access-offline-manifest.ts:379` — "// deleted-path prune."
- `packages/remnic-core/src/access-service-namespace.test.ts:1384` — "// A record() that timed out on the rotation lock spills to the offline-sync"
- `packages/remnic-core/src/access-service-namespace.test.ts:1385` — "// EXCLUDED recall_impressions.jsonl.pending.d/. Without a pre-snapshot drain"
- `packages/remnic-core/src/access-service-namespace.test.ts:1386` — "// the impression is absent from the pushed snapshot and lost if this node is"
- `packages/remnic-core/src/access-service-namespace.test.ts:1387` — "// discarded. offlineSyncSnapshot() must fold the spill into the synced active"
- `packages/remnic-core/src/access-service-namespace.test.ts:1388` — "// recall_impressions.jsonl before building."
- `packages/remnic-core/src/access-service-namespace.test.ts:1405` — "// The writer store roots at config.memoryDir — the SAME instance the drain"
- `packages/remnic-core/src/access-service-namespace.test.ts:1406` — "// must fold from. Here memoryDir === storage.dir (the offline-synced root),"
- `packages/remnic-core/src/access-service-namespace.test.ts:1407` — "// so the folded active file lands in the snapshot."
- `packages/remnic-core/src/access-service-namespace.test.ts:1463` — "// Recall impressions are global: the orchestrator's single LastRecallStore roots"
- `packages/remnic-core/src/access-service-namespace.test.ts:1464` — "// at config.memoryDir, so the active recall_impressions.jsonl lives at"
- `packages/remnic-core/src/access-service-namespace.test.ts:1465` — "// <memoryDir>/state/ and a namespace-rooted snapshot (storage.dir under"
- `packages/remnic-core/src/access-service-namespace.test.ts:1466` — "// namespaces/<token>/) can never carry it. Draining the global pending queue"
- `packages/remnic-core/src/access-service-namespace.test.ts:1467` — "// during such a snapshot would empty the durable queue into a file this"
- `packages/remnic-core/src/access-service-namespace.test.ts:1468` — "// snapshot omits - stranding the row until a root sync - so the drain is scoped"
- `packages/remnic-core/src/access-service-namespace.test.ts:1469` — "// to the snapshot whose root actually contains the file. Here it must be a"
- `packages/remnic-core/src/access-service-namespace.test.ts:1470` — "// no-op, leaving the writer-root spill pending for the root sync, while the"
- `packages/remnic-core/src/access-service-namespace.test.ts:1471` — "// per-namespace lifecycle drain still runs."
- `packages/remnic-core/src/access-service-namespace.test.ts:1489` — "// Writer root (config.memoryDir) is deliberately DISTINCT from the resolved"
- `packages/remnic-core/src/access-service-namespace.test.ts:1490` — "// namespace's storage.dir."
- `packages/remnic-core/src/access-service-namespace.test.ts:1531` — "// sync and no writer-root active file is created."
- `packages/remnic-core/src/access-service-namespace.test.ts:1557` — "// An appendMemoryLifecycleEvents() that timed out on the ledger lock spills the"
- `packages/remnic-core/src/access-service-namespace.test.ts:1558` — "// durable row into the offline-sync-EXCLUDED memory-lifecycle-ledger.jsonl.pending.d/."
- `packages/remnic-core/src/access-service-namespace.test.ts:1559` — "// Without a pre-snapshot drain the promotion/import/explicit-capture row is"
- `packages/remnic-core/src/access-service-namespace.test.ts:1560` — "// absent from the pushed snapshot and lost if this node is discarded before a"
- `packages/remnic-core/src/access-service-namespace.test.ts:1561` — "// later append or maintenance pass folds it. Unlike recall impressions (writer"
- `packages/remnic-core/src/access-service-namespace.test.ts:1562` — "// root), the lifecycle ledger is per-namespace, so the drain runs on the"
- `packages/remnic-core/src/access-service-namespace.test.ts:1563` — "// RESOLVED-namespace storage and the folded ledger lands in the snapshot."
- `packages/remnic-core/src/access-service-namespace.test.ts:1615` — "// When the ledger lock is held by a peer the drain leaves durable rows in the"
- `packages/remnic-core/src/access-service-namespace.test.ts:1616` — "// EXCLUDED pending queue and reports pendingDeferred. A snapshot built then"
- `packages/remnic-core/src/access-service-namespace.test.ts:1617` — "// would silently omit those append-only rows, so the buffered snapshot, the"
- `packages/remnic-core/src/access-service-namespace.test.ts:1618` — "// streaming snapshot, AND the path-enumeration (offlineSyncFiles) entrypoints"
- `packages/remnic-core/src/access-service-namespace.test.ts:1619` — "// MUST abort rather than report success."
