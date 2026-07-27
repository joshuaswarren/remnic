---
"@remnic/core": patch
---

Stop the entity canonical-id migration's full-corpus rewrite loop (#2213).

Once a completed migration journal retains mappings (kept for legacy-id read
compatibility), the completed-state fast path re-ran `rewriteKnownReferences`
— two full hot+cold+archived corpus reads plus cache invalidation and a
memory-status bump — on EVERY `ensureDirectories()`. On a write-active daemon
with a 100k+-file corpus this was a self-sustaining hot loop: the daemon
pinned a core re-reading the corpus, memory caches never warmed, QMD backend
probes and embedding lookups starved past their budgets, and recall degraded
to the multi-second fallback path.

- A stable completed journal (nothing newly discovered, mappings unchanged, no
  park revived) is now a no-op. A park revived by the current run still owes
  its reference rewrite and flows through the main migration path — which now
  also demotes `complete` before rewriting, so a crash mid-rewrite resumes
  (the old in-place fast-path rewrite did not).
- The migration runner's skip fingerprint now keys on the memory-STATUS
  version (entity/status/lifecycle mutations) instead of the corpus scan
  version, which advanced on every plain fact write and defeated the skip on
  any busy daemon.
- What the recurring rewrite used to (eventually) absorb is fixed at the
  source instead: `writeMemory` and `writeChunk` resolve a caller-supplied
  `entityRef` through the completed journal's historical mappings, so
  store-mediated writes — extraction output, explicit capture — can never
  re-introduce legacy entity references. This also puts write-time tombstone
  lookups on the same id space as migrated tombstones. Out-of-band file
  writers remain responsible for their own post-write hooks; reads of legacy
  ids keep resolving through the journal as before.
