# Memory writes go through two-phase CAS receipts and crash-evidencing markers

Status: accepted

## Context
A memory file write (and its durable CAS receipt, deletion record, or capture
dedup index) can crash between any two steps. Readers must never see a mutated
record posing as owned, nor ownership where the write never landed, and a crashed
transaction must be decisively recoverable rather than ambiguous forever.

## Decision
- Every durable write runs as a two-phase receipt transaction under the path lock:
  the PENDING reservation is minted BEFORE the durable file publish (a failed
  reservation leaves the file untouched — never a mutated record without a receipt),
  and the COMMITTED receipt publishes only AFTER the write lands (a failed write can
  never leave the reservation posing as ownership). The post-write fingerprint is
  recorded in the PENDING marker BEFORE publishing, so a crash between the durable
  write and the COMMITTED receipt is decisively recoverable; a recording failure
  must not fail the landed write, so commit still runs and publishes truthfully.
- If the file landed but the COMMITTED receipt never published, the PENDING marker
  stays: readers see unavailable/recovery-needed — never ownership, never absence —
  and promotion/rollback refuse until recovery reconciles. The reservation must NOT
  be aborted in that state.
- An evidenced PENDING marker (write already landed) is lazily recovered on read. A
  reserve-only marker may belong to a LIVE transaction (an unlocked read holds no
  capture-path lock), so it is left for the path-locked write path, which cannot
  race the owner. Reconcile crash-orphaned PENDING markers before the next semantic
  mutation reserves a new token. Writer C cannot reserve while B's PENDING marker
  stands: concurrent ownership is impossible, the ambiguity refuses the new
  transaction.
- The standing revision token is receipt identity, never the public `updated`
  field; reads fail open. Shard policy is strict: a state-bearing shard that does
  not validate is corruption — unavailability, never a usable identity. Pre-two-
  phase shards with a full-shape match read as committed; anything else keeps the
  legacy fall-through. Post-deletion sweeps of a target's receipt shard are best
  effort, keep a crash-recovery PENDING marker, never destroy a shard naming
  another target, and report absence (not an error) when no receipt was minted.
- Capture write markers are exclusive-create; a torn payload is still identifiable
  by the atomic marker filename and mtime, so stale malformed markers can be reaped
  without treating a fresh pre-commit gap as abandoned. Only COMMITTED markers are
  safe for another writer to clear; a pending marker protects the pre-commit gap.
  After the last uncommitted marker clears, restore index authority.
- Lock acquisition for capture mutation is one exclusive-create probe per lock file
  with a bounded outer backoff; the deadline gates each probe, and abort must clear
  timers (raceAbort) so it holds no Timeout.
- Replicated-file sync paths never rebuild the tombstone-blocked index per write
  (it re-reads the whole corpus per file — measured 15-31s each on a ~190k-file
  corpus, multi-week for a boot-scale converge apply): clear the committed marker
  and keep the index as-is, since the index only holds tombstone-blocked keys a
  non-blocked write cannot have changed.
- Tombstone migration source fills are bound to the ledger revision they started
  against; if the ledger advances while a fill awaits, restart against the fresh
  revision instead of publishing a cache built from a stale snapshot, including
  after a direct-path read.
- Card replacement recovery is tier-independent: an interrupted edit's rejected
  predecessor may be demoted to cold or archived before recovery runs, and a
  hot-only lookup would mistake it for deleted and orphan the valid replacement.
  Only a restored active predecessor hides a replacement. Offline sync staging for
  embedding-generation replacement binds staged ciphertext to the FINAL published
  path, and the marker-hiding classification is canonical (YAML/JSON escapes) —
  validate the parsed frontmatter with the same predicate the read path classifies
  by.

This file also covers the smallest neighbouring themes merged in to respect the
file limit: card replacement tier recovery and offline-sync secure staging.

## Consequences
Every write pays a reservation, a fingerprint record, and a receipt publish; crash windows become explicit recovery-needed states that operators must reconcile rather than silent best-effort outcomes.

## Origin comments
- `packages/remnic-core/src/storage/cas-revision-host.ts:8` — "/** * StorageManager CAS receipt host (#2813 / #2807). * Owns fail-open reads, lazy pending recovery, durable digest, an"
- `packages/remnic-core/src/storage/cas-revision-host.ts:14` — "/** Standing CAS revision token \u2014 receipt identity, never public `updated` (#2807). Fail-open on read errors. */"
- `packages/remnic-core/src/storage/cas-revision-host.ts:36` — "// #2807: an evidenced PENDING marker (its write already landed) is"
- `packages/remnic-core/src/storage/cas-revision-host.ts:37` — "// lazily recovered here. A reserve-only marker may belong to a LIVE"
- `packages/remnic-core/src/storage/cas-revision-host.ts:38` — "// transaction \u2014 this read holds no capture path lock \u2014 so it is left"
- `packages/remnic-core/src/storage/cas-revision-host.ts:39` — "// for the path-locked write path, which cannot race the owner."
- `packages/remnic-core/src/storage/cas-revision-host.ts:63` — "/** #2807 (P1): reconcile any crash-orphaned PENDING marker for this * target BEFORE the next semantic mutation reserves"
- `packages/remnic-core/src/storage/cas-revision-host.ts:76` — "/** #2837: best-effort post-deletion sweep of the target's receipt shard. * The durable memory file is already gone, so "
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:40` — "// Writer C cannot reserve while B's PENDING marker stands \u2014 concurrent"
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:41` — "// ownership is impossible: the ambiguity refuses the new transaction."
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:77` — "// A crashed transaction whose memory write LANDED: the pending token"
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:78` — "// publishes as the standing receipt."
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:86` — "// A crashed transaction whose memory write did NOT land: the previous"
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:87` — "// standing token is restored."
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:95` — "// From a fresh target (no standing token), a discarded reservation"
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:96` — "// returns the shard to genuine absence."
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:184` — "// Crash between reserve and the durable write: the file is unchanged,"
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:185` — "// so the baseline fingerprint still matches."
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:195` — "// Same crash from a fresh target (no standing receipt, absent file):"
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:196` — "// the aborted reservation returns the shard to genuine absence."
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:213` — "// A reserve-only marker is indistinguishable from a LIVE transaction"
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:214` — "// between reserve and write, so an unlocked read must not abort it."
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:245` — "// Crash between writeLanded and commit: the marker holds the evidence."
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:279` — "// After the crash the file changes again \u2014 neither the expected"
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:280` — "// fingerprint nor the baseline can explain the current bytes."
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:475` — "// No receipt was ever minted: the sweep reports absence, not an error."
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:485` — "// A PENDING marker is crash-recovery evidence: the sweep must keep it."
- `packages/remnic-core/src/storage/cas-revision-store.test.ts:491` — "// A shard naming another target is never destroyed by this target's sweep."
- `packages/remnic-core/src/storage/cas-revision-store.ts:268` — "// Two-phase shard: strict shape. A state-bearing shard that does not"
- `packages/remnic-core/src/storage/cas-revision-store.ts:269` — "// validate is corruption \u2014 unavailability, never a usable identity."
- `packages/remnic-core/src/storage/cas-revision-store.ts:309` — "// Pre-two-phase shard: a full-shape match reads as committed; anything"
- `packages/remnic-core/src/storage/cas-revision-store.ts:310` — "// else keeps the legacy fall-through (legacy metadata, then absence)."
- `packages/remnic-core/src/storage/tombstone-blocked-capture-index.ts:66` — "/** * Durable targeted deduplication for tombstone-blocked explicit captures. * * The active fact-hash index i"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-index.ts:135` — "// A torn payload can lose its JSON metadata, but the atomic"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-index.ts:136` — "// marker filename and filesystem mtime still identify its owner"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-index.ts:137` — "// and age. Preserve both so stale malformed markers can be"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-index.ts:138` — "// reaped without treating a fresh pre-commit gap as abandoned."
- `packages/remnic-core/src/storage/tombstone-blocked-capture-index.ts:235` — "// A pending marker protects the pre-commit gap; only committed markers are safe for another writer to clear."
- `packages/remnic-core/src/storage/tombstone-blocked-capture-index.ts:543` — "/** * Drop an already-committed write marker without re-reading the corpus. The * offline-sync mutation path c"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-index.ts:552` — "// getIndex() may have rebuilt while this marker was still pending and"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-index.ts:553` — "// left authoritative=false. After the marker is gone, restore authority"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-index.ts:554` — "// if no other uncommitted marker remains."
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:21` — "/** * One exclusive-create probe. The bounded wait lives in the outer backoff, * which runs only after every l"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:69` — "/** Direct seam. Converge passes the same signal through `lockOptions` instead. */"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:104` — "/** Prefer the constructor seam; converge installs the signal on lock options at acquire time. */"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:109` — "/** * One probe of a single lock file. Returns the retry symbol when the lock * is busy and the permanent symb"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:153` — "// The deadline gates each probe: a chain that started before the"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:154` — "// deadline must not keep probing locks (or run the write) after it."
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:181` — "// raceAbort covers seam sleeps that ignore the signal; the default"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:182` — "// sleepAbortable also clears its timer so abort holds no Timeout."
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:337` — "// #2813 (P1 C): a two-phase receipt transaction under this same"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:338` — "// path lock. The PENDING reservation is minted BEFORE the durable"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:339` — "// file publish, so a failed reservation leaves the memory file"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:340` — "// untouched \u2014 never a mutated record without a receipt. The"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:341` — "// COMMITTED receipt publishes only AFTER the write lands, so a"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:342` — "// failed write can never leave the reservation posing as"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:343` — "// ownership."
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:349` — "// The memory write failed (or never ran): abort the reservation so"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:350` — "// no pending marker survives a write that did not land. A failed"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:351` — "// abort keeps the marker \u2014 ambiguity, recovered later."
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:365` — "// #2807: record the post-write fingerprint in the PENDING marker"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:366` — "// BEFORE publishing, so a crash between the durable write and the"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:367` — "// COMMITTED receipt is decisively recoverable. The evidence only"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:368` — "// guards that crash window \u2014 a recording failure must not fail the"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:369` — "// landed write, so commit still runs and publishes truthfully."
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:380` — "// #2813 (P1 C): the memory file LANDED but the COMMITTED receipt"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:381` — "// never published. The PENDING marker stays: readers must see"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:382` — "// unavailable/recovery-needed \u2014 never ownership, never absence \u2014"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:383` — "// and promotion/rollback refuse until recovery reconciles. The"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-mutation.ts:384` — "// reservation must NOT be aborted: the write is on disk."
- `packages/remnic-core/src/storage/tombstone-blocked-capture-sync.ts:212` — "/** #2837: durable unlink plus deletion-revision record, WITHOUT the CAS * shard sweep \u2014 the concrete {@link d"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-sync.ts:219` — "/** #2813 (P1 C, #2807): reserve the target's next durable CAS revision * token as a two-phase receipt transac"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-sync.ts:229` — "/** #2837 (shard cleanup): after a managed memory file is durably deleted, * sweep its per-target CAS receipt "
- `packages/remnic-core/src/storage/tombstone-blocked-capture-sync.ts:546` — "// The index only holds tombstone-blocked explicit-capture keys, so a"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-sync.ts:547` — "// write where neither side is blocked cannot have changed it. Rebuilding"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-sync.ts:548` — "// here re-reads the whole corpus per replicated file \u2014 measured 15-31s"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-sync.ts:549` — "// per write against a ~190k-file corpus, which turns a boot-scale"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-sync.ts:550` — "// `converge apply` into a multi-week run. Clear the committed marker and"
- `packages/remnic-core/src/storage/tombstone-blocked-capture-sync.ts:551` — "// keep the index as-is."
- `packages/remnic-core/src/storage/tombstone-migration-sources.test.ts:60` — "// First fill stalls while a peer retires a legacy memory; the"
- `packages/remnic-core/src/storage/tombstone-migration-sources.test.ts:61` — "// generation is bound at call entry so the stall cannot upgrade"
- `packages/remnic-core/src/storage/tombstone-migration-sources.test.ts:62` — "// it to the fresh revision."
- `packages/remnic-core/src/storage/tombstone-migration-sources.test.ts:85` — "// Without the revision guard, the first callback would miss on the"
- `packages/remnic-core/src/storage/tombstone-migration-sources.test.ts:86` — "// stale snapshot, publish a full map built from it, and resolve empty."
- `packages/remnic-core/src/storage/tombstone-migration-sources.ts:6` — "/** * Deps injected by `StorageManager.buildTombstoneStore` so this module owns no * storage-god-file imports "
- `packages/remnic-core/src/storage/tombstone-migration-sources.ts:18` — "/** * Build the `sourceContentsForMemoryIds` callback `TombstoneStore` uses to * verify pre-Unicode rows again"
- `packages/remnic-core/src/storage/tombstone-migration-sources.ts:38` — "// ENOENT / stat failure \u2014 keep whatever is cached."
- `packages/remnic-core/src/storage/tombstone-migration-sources.ts:48` — "// In-flight fills are bound to the ledger revision they started"
- `packages/remnic-core/src/storage/tombstone-migration-sources.ts:49` — "// against: if the ledger advances while a fill awaits, restart"
- `packages/remnic-core/src/storage/tombstone-migration-sources.ts:50` — "// against the fresh revision instead of publishing a cache built"
- `packages/remnic-core/src/storage/tombstone-migration-sources.ts:51` — "// from a stale path snapshot (issue #2367 review round 2)."
- `packages/remnic-core/src/storage/tombstone-migration-sources.ts:66` — "// Re-check after the direct-path read too: a concurrent drop during"
- `packages/remnic-core/src/storage/tombstone-migration-sources.ts:67` — "// that await must not let this call publish a fill built from the"
- `packages/remnic-core/src/storage/tombstone-migration-sources.ts:68` — "// stale snapshot into the freshly cleared slot (issue #2367 round 3)."
- `packages/remnic-core/src/support-passport/card-service.test.ts:1462` — "// Interrupted state: the prior draft is durably rejected while the"
- `packages/remnic-core/src/support-passport/card-service.test.ts:1463` — "// replacement still carries its prepared marker. Simulate tier"
- `packages/remnic-core/src/support-passport/card-service.test.ts:1464` — "// migration demoting the rejected predecessor to the cold tier."
- `packages/remnic-core/src/support-passport/card-service.ts:976` — "// Tier-independent: an interrupted edit's rejected predecessor can be"
- `packages/remnic-core/src/support-passport/card-service.ts:977` — "// demoted to the cold tier before recovery runs; a hot-only lookup would"
- `packages/remnic-core/src/support-passport/card-service.ts:978` — "// mistake it for deleted and orphan the valid replacement (#2387)."
- `packages/remnic-core/src/support-passport/card-state.ts:155` — "// The replaced draft may be demoted to the cold tier or archived after"
- `packages/remnic-core/src/support-passport/card-state.ts:156` — "// its rejection; a hot-only projection then reports it missing. A"
- `packages/remnic-core/src/support-passport/card-state.ts:157` — "// missing predecessor must not hide the replacement \u2014 only a restored"
- `packages/remnic-core/src/support-passport/card-state.ts:158` — "// active predecessor does (#2387)."
- `packages/remnic-core/src/support-passport/offline-sync-guard.ts:75` — "// Canonical classification (#2387): YAML/JSON escapes \u2014 e.g. a"
- `packages/remnic-core/src/support-passport/offline-sync-guard.ts:76` — "// structured-attribute key written as `support\\u002dpassport-owner` \u2014 hide"
- `packages/remnic-core/src/support-passport/offline-sync-guard.ts:77` — "// the marker from the raw scan above, while the storage reader's"
- `packages/remnic-core/src/support-passport/offline-sync-guard.ts:78` — "// JSON.parse reconstructs it after the write. Validate the parsed"
- `packages/remnic-core/src/support-passport/offline-sync-guard.ts:79` — "// frontmatter with the same predicate the read path classifies by."
- `packages/remnic-core/src/support-passport/offline-sync-guard.ts:226` — "// Secure staging for embedding-generation replacement (#3150): staged"
- `packages/remnic-core/src/support-passport/offline-sync-guard.ts:227` — "// ciphertext binds the FINAL published path, matching the snapshot apply."
