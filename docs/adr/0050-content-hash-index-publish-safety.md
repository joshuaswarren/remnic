# Content-hash index deltas are snapshotted per publish with durable retries

Status: accepted

## Context
The content-hash index is shared across processes and mutated concurrently.
A save awaits disk, so add()/remove() can land mid-save; consuming the LIVE delta
sets after a publish would drop late hashes AND clear dirty, stranding them in no
save at all — peers would never see them until a corpus rebuild. Lock timeouts and
stale local membership compound the problem.

## Decision
- Snapshot the deltas (added/removed) an overwrite or reconcile publish is
  responsible for BEFORE the write yields the event loop; consume only what was
  published. Anything that arrived during the awaits stays pending for the next
  save. Clearing the live sets unconditionally is forbidden.
- Re-baseline the freshness fingerprint (captured under the held lock) after a
  publish so our own write is never later mistaken for a peer's advance. A stat
  failure other than ENOENT leaves no baseline: the next freshness check reports
  non-current and the caller confirms against the corpus.
- A full clear is always paired with a plain overwrite rebuild save (subsuming
  pending deltas) and cancels any armed deferred-reconcile retry so it cannot fire
  in the clear-to-rebuild-to-save window and union pre-clear rows back.
- A re-add supersedes a pending removal of the same hash; a removal is recorded
  even when the hash is not in the local set (local membership can be STALE — a
  peer removed it on disk), supersedes a pending add, and always marks dirty.
  Set semantics keep this idempotent and preserve remove/add ordering.
- If late deltas landed mid-save, arm a bounded durable retry so they reach disk
  even without a further batch save — never a silent in-memory-only hash and never
  a settled barrier over pending work. The retry republishes only OUR delta under
  the lock; a clean overwrite supersedes pending retry work.
- Never publish unlocked: a concurrent locked writer holds the lock, so overwriting
  now could clobber its addition. Keep dirty and schedule the durable background
  retry; if the lock cannot be held, leave the index as-is and let the caller retry
  the authoritative rebuild on next use. A publish-time I/O/encryption error (not a
  lock timeout) is best-effort: log and let the corpus-rebuild safety net cover it
  rather than loop.
- Hashes from the pre-NFC format are unsafe after normalization changes: ignore
  them on load and never carry them into a v2 write, until an authoritative corpus
  rebuild publishes v2.
- The fact-only partition lives on the index instance (not a parallel set kept in
  lockstep by hand), so every path that mutates the shared set and needs fact-only
  truth mutates it in the same breath.

## Consequences
Every save carries a delta snapshot and possible retry scheduling; pre-NFC hashes are invisible until a v2 rebuild runs.

## Origin comments
- `packages/remnic-core/src/storage/content-hash-index.ts:40` — "/** * Durable-retry policy for a deferred content-hash reconcile save whose * cross-process lock acquire timed out (issu"
- `packages/remnic-core/src/storage/content-hash-index.ts:216` — "// Hashes from the pre-NFC format are unsafe after normalization changes."
- `packages/remnic-core/src/storage/content-hash-index.ts:217` — "// Ignore them until an authoritative corpus rebuild publishes v2."
- `packages/remnic-core/src/storage/content-hash-index.ts:229` — "// The loaded set now reflects the on-disk file \u2014 baseline the fingerprint so"
- `packages/remnic-core/src/storage/content-hash-index.ts:230` — "// a later peer write is detectable (PR #2016 review)."
- `packages/remnic-core/src/storage/content-hash-index.ts:257` — "// A stat failure other than ENOENT leaves no baseline; the next freshness"
- `packages/remnic-core/src/storage/content-hash-index.ts:258` — "// check reports non-current and the caller confirms against the corpus."
- `packages/remnic-core/src/storage/content-hash-index.ts:321` — "// A re-add supersedes a pending removal of the same hash (round 8 thread 3)."
- `packages/remnic-core/src/storage/content-hash-index.ts:323` — "// Record OUR durable delta even when the local snapshot already holds the"
- `packages/remnic-core/src/storage/content-hash-index.ts:324` — "// hash (PR #2016 thread SD-nG): local membership can be STALE \u2014 a peer"
- `packages/remnic-core/src/storage/content-hash-index.ts:325` — "// removed this hash on disk while this instance kept it in memory. Skipping"
- `packages/remnic-core/src/storage/content-hash-index.ts:326` — "// `added`/`dirty` on that path let the reconciling save compute"
- `packages/remnic-core/src/storage/content-hash-index.ts:327` — "// (on-disk \\ removed) \u222a added and silently drop the reintroduced hash, so"
- `packages/remnic-core/src/storage/content-hash-index.ts:328` — "// the peer never saw it again. Set semantics keep this idempotent (no"
- `packages/remnic-core/src/storage/content-hash-index.ts:329` — "// duplicate entries) and the `removed.delete` above preserves remove/add"
- `packages/remnic-core/src/storage/content-hash-index.ts:330` — "// ordering."
- `packages/remnic-core/src/storage/content-hash-index.ts:348` — "// A full clear is always paired with a plain overwrite save() (rebuild);"
- `packages/remnic-core/src/storage/content-hash-index.ts:349` — "// pending per-hash add/remove deltas are subsumed by writing the rebuilt set."
- `packages/remnic-core/src/storage/content-hash-index.ts:350` — "// Cancel any armed deferred-reconcile retry (PR #2016) so it cannot fire in"
- `packages/remnic-core/src/storage/content-hash-index.ts:351` — "// the clear\u2192rebuild\u2192save window and union the pre-clear on-disk rows back."
- `packages/remnic-core/src/storage/content-hash-index.ts:362` — "// Snapshot the deltas + overwrite body THIS save publishes BEFORE the write"
- `packages/remnic-core/src/storage/content-hash-index.ts:363` — "// yields the event loop. `writeMaybeEncryptedFile` materializes `serialized`"
- `packages/remnic-core/src/storage/content-hash-index.ts:364` — "// eagerly, then the disk await lets a concurrent same-process add()/remove()"
- `packages/remnic-core/src/storage/content-hash-index.ts:365` — "// land a late delta (PR #2016 thread PRRT_kwDORJXyws6SEBri). Clearing the"
- `packages/remnic-core/src/storage/content-hash-index.ts:366` — "// LIVE added/removed sets afterward \u2014 as the previous unconditional"
- `packages/remnic-core/src/storage/content-hash-index.ts:367` — "// clear()+`dirty = false` did \u2014 would drop that late hash from the index AND"
- `packages/remnic-core/src/storage/content-hash-index.ts:368` — "// leave no retry, so peers never see it until a corpus rebuild. Consume only"
- `packages/remnic-core/src/storage/content-hash-index.ts:369` — "// what we published; late deltas stay pending. Mirrors saveMergingWithDisk."
- `packages/remnic-core/src/storage/content-hash-index.ts:375` — "// Consume ONLY the deltas this overwrite published; anything that arrived"
- `packages/remnic-core/src/storage/content-hash-index.ts:376` — "// during the awaits above remains pending for the next save."
- `packages/remnic-core/src/storage/content-hash-index.ts:381` — "// This overwrite is now the on-disk state \u2014 re-baseline the freshness"
- `packages/remnic-core/src/storage/content-hash-index.ts:382` — "// fingerprint so our own write is not later mistaken for a peer's (PR #2016)."
- `packages/remnic-core/src/storage/content-hash-index.ts:385` — "// Late deltas landed mid-save: arm a bounded durable retry so they reach"
- `packages/remnic-core/src/storage/content-hash-index.ts:386` — "// disk even without a further batch save \u2014 never a silent in-memory-only"
- `packages/remnic-core/src/storage/content-hash-index.ts:387` — "// hash. The locked reconcile republishes only OUR delta onto the overwrite."
- `packages/remnic-core/src/storage/content-hash-index.ts:390` — "// Clean overwrite supersedes any pending deferred reconcile work."
- `packages/remnic-core/src/storage/content-hash-index.ts:425` — "// Snapshot the deltas this publish is responsible for. The read+rewrite"
- `packages/remnic-core/src/storage/content-hash-index.ts:426` — "// below yields the event loop, so a concurrent add()/remove() can land"
- `packages/remnic-core/src/storage/content-hash-index.ts:427` — "// new deltas while we await disk (PR #2016 thread SD7Tj). Consuming the"
- `packages/remnic-core/src/storage/content-hash-index.ts:428` — "// LIVE sets afterward would drop those late deltas AND clear `dirty`,"
- `packages/remnic-core/src/storage/content-hash-index.ts:429` — "// stranding them in no save at all. We consume only what we published;"
- `packages/remnic-core/src/storage/content-hash-index.ts:430` — "// anything that arrived meanwhile stays pending for the next save."
- `packages/remnic-core/src/storage/content-hash-index.ts:443` — "// Do not carry hashes from the pre-NFC format into a v2 write."
- `packages/remnic-core/src/storage/content-hash-index.ts:472` — "// The reconciled set is now the on-disk state \u2014 re-baseline the freshness"
- `packages/remnic-core/src/storage/content-hash-index.ts:473` — "// fingerprint (captured under the held lock) so our own publish is not"
- `packages/remnic-core/src/storage/content-hash-index.ts:474` — "// later mistaken for a peer's advance (PR #2016 review)."
- `packages/remnic-core/src/storage/content-hash-index.ts:486` — "// Never publish unlocked (round 9 finding 2): keep dirty AND schedule a"
- `packages/remnic-core/src/storage/content-hash-index.ts:487` — "// durable background retry (PR #2016). Relying on an unguaranteed later"
- `packages/remnic-core/src/storage/content-hash-index.ts:488` — "// batch save silently left the addition in this process's memory only;"
- `packages/remnic-core/src/storage/content-hash-index.ts:489` — "// the retry keeps re-attempting the locked publish until the addition"
- `packages/remnic-core/src/storage/content-hash-index.ts:490` — "// lands on disk."
- `packages/remnic-core/src/storage/content-hash-index.ts:505` — "// A concurrent add()/remove() landed during publish's disk awaits, so"
- `packages/remnic-core/src/storage/content-hash-index.ts:506` — "// deltas remain unpersisted (PR #2016 thread SD7Tj). Arm a bounded"
- `packages/remnic-core/src/storage/content-hash-index.ts:507` — "// durable retry so they reach disk even if no further batch save comes"
- `packages/remnic-core/src/storage/content-hash-index.ts:508` — "// \u2014 never leave a settled barrier over pending work."
- `packages/remnic-core/src/storage/content-hash-index.ts:558` — "// Never publish unlocked: a concurrent locked writer holds the lock,"
- `packages/remnic-core/src/storage/content-hash-index.ts:559` — "// so overwriting now could clobber its addition. Leave the index as-is"
- `packages/remnic-core/src/storage/content-hash-index.ts:560` — "// and let the caller retry the authoritative rebuild on next use."
- `packages/remnic-core/src/storage/content-hash-index.ts:567` — "// Publish under the held lock. save() takes no lock (no re-entrancy) and"
- `packages/remnic-core/src/storage/content-hash-index.ts:568` — "// is a full overwrite that supersedes any pending add/remove deltas."
- `packages/remnic-core/src/storage/content-hash-index.ts:674` — "// A publish-time I/O/encryption error (not a lock timeout) is best-effort:"
- `packages/remnic-core/src/storage/content-hash-index.ts:675` — "// log and let the corpus-rebuild safety net cover it rather than loop."
- `packages/remnic-core/src/storage/content-hash-index.ts:708` — "// Record the removal (round 8 thread 3) even when the hash is not in our"
- `packages/remnic-core/src/storage/content-hash-index.ts:709` — "// in-memory set \u2014 a reconciling save must still drop it from the latest"
- `packages/remnic-core/src/storage/content-hash-index.ts:710` — "// on-disk state. A removal supersedes a pending add. Always mark dirty."
- `packages/remnic-core/src/storage/content-hash-index.ts:744` — "// hash (PR #2016 thread PRRT_kwDORJXyws6SEHve). Outside a rebuild"
- `packages/remnic-core/src/storage/content-hash-index.ts:745` — "// (StorageManager.addActiveFactContentHash on reactivation) local"
- `packages/remnic-core/src/storage/content-hash-index.ts:746` — "// membership can be STALE: a peer removed this hash on disk while this"
- `packages/remnic-core/src/storage/content-hash-index.ts:747` — "// instance kept it in memory. Skipping added/dirty on that path let the"
- `packages/remnic-core/src/storage/content-hash-index.ts:748` — "// reconciling save compute (on-disk \\ removed) \u222a added and silently drop"
- `packages/remnic-core/src/storage/content-hash-index.ts:749` — "// the reintroduced hash, so the peer never saw it again. Set semantics keep"
- `packages/remnic-core/src/storage/content-hash-index.ts:750` — "// this idempotent (no duplicate entries) and the removed.delete above"
- `packages/remnic-core/src/storage/content-hash-index.ts:751` — "// preserves remove/add ordering. Mirrors add()."
- `packages/remnic-core/src/storage/content-hash-index.ts:758` — "// Folded here from StorageManager's parallel `factOnlyHashes` set, which had"
- `packages/remnic-core/src/storage/content-hash-index.ts:759` — "// to be kept in lockstep by hand on every add/remove/rebuild site. The"
- `packages/remnic-core/src/storage/content-hash-index.ts:760` — "// partition lives on the index instance, so every path that mutates the"
- `packages/remnic-core/src/storage/content-hash-index.ts:761` — "// shared set and needs fact-only truth mutates it in the same breath."
