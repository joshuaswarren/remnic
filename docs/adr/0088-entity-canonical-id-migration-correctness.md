# Entity canonical-id migration parks unresolvable collisions and resumes crash-exactly

Status: accepted

## Context
Rewriting entity ids across a whole corpus cannot always resolve a legacy id:
some canonical ids are claimed by more than one legacy file with no non-arbitrary
winner (readdir order is not stable and differs between hosts), and some files are
Finder metadata or unparseable. A migration that guesses would strand memories on
filenames that no longer exist; one that aborts took the daemon down. Completion
must be crash-resumable and must never re-scan the entire corpus on every
`ensureDirectories()`.

## Decision
- Unresolvable collisions are PARKED, never dropped: deleting the record would
  strand the collision. Blocks describe THIS scan only (rebuilt per pass) —
  accumulating them across a run would let a collision another writer has since
  resolved keep pruning its now-valid mapping and rename the entity file while the
  pruned mapping skips the reference rewrite. A park survives ONLY while this scan
  re-establishes the collision; a park whose legacy file is gone was resolved by
  keeping the canonical side and its record is the only thing that can still
  perform the reference rewrite. A park resolved after the rewrite pass must still
  be APPLIED — completing on discovery alone fingerprints the post-deletion corpus
  and strands the references forever.
- Parked targets follow ACTIVE moves (parked A-to-B beside active B-to-C promotes
  to A-to-C) but never hop a still-blocked link; chains are collapsed transitively
  before anything consumes the set. This scan's verdict wins over a stale journal
  parked target. Pairs whose files are GONE are tracked separately and pruned when
  the canonical file is gone too; one aggregated operator line per run reports the
  whole list and the remedy.
- AppleDouble/`.DS_Store` and unparseable entity files are skipped in place, not
  fatal: skipping has the same outcome as the old throw without refusing to boot.
  A journal entry must not relocate such a file; the mapping stays for later repair.
- Every journal publish (additive merges, completion markers, prunes) serializes
  under the entity MUTATION lock; parking/removing an active mapping mid-entity-
  write would land a mutation on a now-unrelated canonical claimant, and the
  reconcile pass rewrites references but cannot move a misplaced mutation.
- Reconcile-pending markers: a raw-byte writer (offline sync, consolidation-undo,
  governance restore) may have landed bytes this process never vetted and requests
  ONE reference-reconciliation pass. The observed generation is renamed aside
  BEFORE the pass so a request made while this run scans creates a fresh marker
  that survives finish(); a `.consuming` file left by a crashed run still owes its
  pass. A stable journal with a pending marker runs ONE bounded rewrite pass, then
  finish() consumes the marker.
- finish() consumption invariant: every finish path either just rewrote references,
  has none to rewrite, or observed no marker — so the CONSUMED generation is
  removed there. A fresh marker written mid-run is untouched. ORDER MATTERS: read
  the completion fingerprint BEFORE the marker check, so no window can seal a
  marker the check never saw; a marker landing after either causes the runner to
  retry and consume the fresh generation. An undefined completion fingerprint is a
  deliberate signal to propagate (retry), never to recompute. A stable completed
  journal is a no-op — re-running the rewrite re-read the entire corpus twice per
  call and caused a self-sustaining hot loop (multi-GB/s re-reads, caches never
  warm, recall degraded to fallback).
- Search maintenance is requested only after a pass that rewrote references, via a
  maintenance-pending marker (issue #3286) that the next startup's no-op replay
  fires exactly once; the marker clears only after the pass actually runs, not at
  request time, so a crash inside the debounce window does not lose the re-index.
  Markers owned by earlier runs are cleared by this run plus its own, never a
  marker a concurrent run arms meanwhile. The async hook is served after a debounce
  and never holds startup. The version bump happens only after a pass that rewrote
  references; a no-op replay must not ask for maintenance unless a previous run
  died owing it.
- The amortized completion cache keys on every getFingerprint input (entity entry
  identities catch same-path edits) and refuses a symlinked entities root before
  fingerprinting; entities/ absence is uncacheable so a false complete is never
  pinned. Rename candidates treat ENOENT as retry and ELOOP (planted symlink) as
  skip. The completion fingerprint covers migration inputs only.
- The entry enumeration (one lstat per entity file — a corpus-sized syscall storm)
  runs in the corpus-scan worker, not on the main thread.

## Consequences
Parked pairs keep unreadable legacy ids alive indefinitely until resolved; crash windows are widened (marker-armed early, consumed late) to guarantee resumability.

## Origin comments
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:57` — "// The migration bumps the status version only after a pass that rewrote"
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:58` — "// references; a no-op replay must not ask search maintenance to run unless a"
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:59` — "// previous run died owing it (issue #3286 pending marker)."
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:61` — "// Markers an earlier run left behind: this run owes (and may clear) exactly"
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:62` — "// these plus its own, never a marker a concurrent run arms meanwhile."
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:64` — "// Arm the marker before this run rewrites anything, so a crash between the"
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:65` — "// rewrite and the hook leaves it behind. Idempotent per run."
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:114` — "// An async hook is served after a debounce: never hold startup for it."
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:121` — "// An undefined completion fingerprint is a deliberate signal (issue #2213):"
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:122` — "// a reconcile marker landed while the run scanned, and recomputing the"
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:123` — "// fingerprint here would seal that pending request into the runner's"
- `packages/remnic-core/src/storage/entity-canonical-id-migration-adapter.ts:124` — "// completed state. Propagate it so the runner retries instead."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:52` — "/** * Pairs the migration refused to resolve, PARKED rather than dropped. * Deleting the record would strand the collisi"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:106` — "/** * Completion fingerprint for migration inputs only. Entity entry identities * catch same-path edits that do not chan"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:125` — "// The entry enumeration is one lstat per entity file \u2014 a corpus-sized"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:126` — "// syscall storm on the main thread. It runs in the corpus-scan worker."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:279` — "/** * Every journal publish \u2014 additive merges, completion markers, prunes \u2014 * serializes under the entity MUTATION lock "
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:371` — "/** * Legacy ids the migration cannot resolve on its own, mapped to the canonical * id they collide with. Two entity fil"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:393` — "// Blocks describe THIS scan of the directory, so they are rebuilt per pass."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:394` — "// Accumulating them across a run would let a collision another writer has"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:395` — "// since resolved keep pruning its now-valid mapping: the entity file gets"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:396` — "// renamed while the pruned mapping skips the reference rewrite, stranding"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:397` — "// memories on a filename that no longer exists."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:401` — "// AppleDouble (`._*`) and `.DS_Store` are Finder metadata, not entity"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:402` — "// files. A real file that cannot be parsed is left in place: this scan"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:403` — "// runs during directory init, and aborting it took the daemon down."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:404` — "// Skipping is the same outcome as the old throw (the file is not"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:405` — "// rewritten) without refusing to boot. Symlink checks above still run."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:446` — "// A canonical id claimed by more than one legacy file has no non-arbitrary"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:447` — "// winner, and readdir order is not stable (\u00a76) - so the \"winner\" would differ"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:448` — "// between hosts reading identical data. Block every claimant instead."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:775` — "// A mapping persisted by an older build, or a file changed since"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:776` — "// discovery. Same verdict as discovery: skip the pair, keep both files."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:806` — "// A journal entry must not relocate Finder metadata or a record this scan"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:807` — "// would leave in place. readStorageSecureFile has already decrypted, so"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:808` — "// the check is on that plaintext. The mapping stays for a later repair."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:859` — "// A raw-byte writer (offline sync, consolidation-undo, governance"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:860` — "// restore) may have landed memory bytes this process never vetted; the"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:861` — "// marker requests ONE reference-reconciliation pass (issue #2213). The"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:862` — "// observed generation is RENAMED aside before the pass so a request made"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:863` — "// WHILE this run scans creates a fresh marker that survives finish() \u2014"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:864` — "// and a `.consuming` file left by a crashed run still owes its pass."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:883` — "// Parks for pairs whose files are GONE, tracked separately from"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:884` — "// collision parks: pruneBlocked drops these (the canonical file is gone"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:885` — "// too), and the rescan's blocked.clear() would otherwise silence them"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:886` — "// before finish() reports anything."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:888` — "// ONE aggregated line per run, not one per pair per restart: this used to"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:889` — "// abort the daemon, so the operator needs the whole list and the remedy."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:915` — "// Every finish() path either just rewrote references (main/reconcile"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:916` — "// paths), has none to rewrite (empty mappings), or observed no marker"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:917` — "// (stable no-op) \u2014 so the CONSUMED generation is removed here. A fresh"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:918` — "// marker written mid-run is untouched, and a crash before this point"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:919` — "// leaves `.consuming` set for the next run (the rewrite is idempotent)."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:925` — "// A FRESH marker written while this run scanned means bytes landed the"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:926` — "// pass may not have covered. Withholding the completion fingerprint"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:927` — "// makes the runner's stability check fail, so it immediately retries \u2014"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:928` — "// and the retry consumes the fresh generation. ORDER MATTERS: read the"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:929` — "// fingerprint BEFORE the marker check. A marker landing after the"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:930` — "// fingerprint read but before the check is caught by the check; one"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:931` — "// landing after the check is absent from the returned fingerprint, so"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:932` — "// the live marker mismatches the runner's cached completion and the"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:933` — "// next ensure() re-invokes. Checking first left a window where the"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:934` — "// fingerprint could SEAL a marker the check never saw."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:943` — "/** * Drop blocked pairs from the working set. Discovery only refuses to * ADD them; a mapping persisted by an earlier r"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:954` — "// THIS scan's verdict wins over the journal: normalization can change"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:955` — "// between runs, so a stale parked target would otherwise be promoted"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:956` — "// later and rewrite references onto an id that does not exist."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:964` — "// A parked pair whose legacy file is gone was resolved by keeping the"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:965` — "// canonical side. The rename is moot; the reference rewrite is not, and"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:966` — "// this record is the only thing that can still perform it."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:967` — "// A park survives ONLY while this scan re-establishes the collision."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:968` — "// Anything else - the scan found a real migration, or found the source"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:969` — "// needs none (already canonical under a newer normalization) - makes"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:970` — "// the record obsolete, and keeping it lets a later deletion promote a"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:971` — "// target the entity never occupied."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:978` — "// Resolve the parked target through ACTIVE moves before deciding"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:979` — "// its file is gone: a parked A -> B beside an active B -> C must"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:980` — "// promote to A -> C and rewrite, not drop because B was moved"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:981` — "// out-of-band. Only a target with no surviving file may drop."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:996` — "// Reviving a whole chain at once yields A -> B -> C, and each rewrite"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:997` — "// surface makes a different number of passes over it - so collapse"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:998` — "// transitively before anything consumes the set."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1000` — "// Parked targets follow ACTIVE moves only: hopping over a still-blocked"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1001` — "// link would jump to an id the migration has not been allowed to reach."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1010` — "// Parking/removing an active mapping mid-entity-write would land an"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1011` — "// alias/activity/relationship mutation on a now-unrelated canonical"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1012` — "// claimant \u2014 the reconcile pass rewrites references, it cannot move"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1013` — "// a misplaced mutation. publishState serializes under the lock."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1034` — "// Stable completed journal \u2192 no-op (issue #2213). Retained mappings are"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1035` — "// read-compat state whose references were already rewritten (to"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1036` — "// convergence) before `complete: true` was persisted, so re-running"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1037` — "// `rewriteKnownReferences` here re-read the ENTIRE hot+cold+archived"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1038` — "// corpus \u2014 twice \u2014 and invalidated every memory cache on EVERY"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1039` — "// `ensureDirectories()`. On a write-active daemon that was a"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1040` — "// self-sustaining hot loop (multi-GB/s of re-reads, caches never warm,"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1041` — "// recall degraded to the fallback path). A park revived by THIS run's"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1042` — "// pruneBlocked still owes its reference rewrite: it falls through to"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1043` — "// the main flow below, which demotes `complete` BEFORE rewriting \u2014 so"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1044` — "// a crash mid-rewrite resumes, which the old in-place rewrite did not."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1051` — "// Stable journal, but a raw-byte writer requested reconciliation:"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1052` — "// run ONE bounded rewrite pass over the retained mappings, then let"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1053` — "// finish() consume the marker."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1081` — "// Reconcile before declaring completion: this rescan can resolve a"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1082` — "// park (another writer removed the legacy file), and completing"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1083` — "// without promoting it strands its references behind a fingerprint"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1084` — "// that already reflects the deletion - so no later run revisits it."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1115` — "// Deferred means both files are missing: no later pass can help"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1116` — "// these pairs, so park them all instead of Fatal-exiting."
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1142` — "// A park resolved after the rewrite pass is promoted here, and a"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1143` — "// promotion still has to be APPLIED. Completing on `discoveredAfter`"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1144` — "// alone fingerprints the post-deletion corpus, so the runner never"
- `packages/remnic-core/src/storage/entity-canonical-id-migration.ts:1145` — "// retries and those references stay stranded."
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:399` — "/** * Reconcile-pending marker (issue #2213). Raw-byte memory writers that CANNOT * canonicalize inline \u2014 offline-sync f"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:444` — "// Best effort by design: a marker failure must not fail the restore/sync"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:445` — "// that requested it (AGENTS.md \u00a74). The reference stays legacy-but-readable"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:446` — "// until the next mapping change."
- `packages/remnic-core/src/storage/entity-migration-completion-cache.nofollow.test.ts:1` — "/** * Regression: amortized completion must refuse a symlinked entities root * before getFingerprint \u2192 fingerprintEntity"
- `packages/remnic-core/src/storage/entity-migration-completion-cache.nofollow.test.ts:108` — "// Plain probe script (no nested --test: parent already runs under the test"
- `packages/remnic-core/src/storage/entity-migration-completion-cache.nofollow.test.ts:109` — "// runner, and node skips recursive test-file execution)."
- `packages/remnic-core/src/storage/entity-migration-completion-cache.nofollow.test.ts:110` — "// Dynamic import loads cache after mock.module wraps readdir."
- `packages/remnic-core/src/storage/entity-migration-completion-cache.ts:1` — "/** * Amortized entity canonical-id migration completion verdict for entity reads. * * Key covers every getFingerprint i"
- `packages/remnic-core/src/storage/entity-migration-completion-cache.ts:32` — "/** * True when `entitiesDir` is a real directory inside `baseDir`. * lstat first so a symlinked root is never realpath'"
- `packages/remnic-core/src/storage/entity-migration-completion-cache.ts:73` — "/** * Cheap coherence key. entities/ absence is uncacheable (random suffix) so * we never pin a false complete. */"
- `packages/remnic-core/src/storage/entity-migration-completion-cache.ts:126` — "// ENOENT: renamed away (retry below). ELOOP: planted symlink \u2014 skip."
- `packages/remnic-core/src/storage/entity-migration-completion-cache.ts:147` — "// ENOENT/ELOOP: gone or a planted symlink \u2014 try the next candidate."
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:10` — "// Issue #3286: a crash between the reference rewrite and the completion hook"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:11` — "// must not leave the QMD index stale. A \"maintenance pending\" marker beside the"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:12` — "// migration journal makes the next startup's no-op replay fire the hook once."
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:27` — "/** * Seed a corpus with one legacy-typed entity file and one memory referencing * it by the legacy id, so a later run h"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:35` — "// Create the directory skeleton (facts/ is date-partitioned on write, so"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:36` — "// the raw file below lands in a directory ensureDirectories has made)."
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:48` — "// Seed the memory file fully raw with the legacy entityRef: writeMemoryFrontmatter"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:49` — "// would canonicalize the ref through the journal this pass is about to build,"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:50` — "// and a raw edit after a cached read would serve the stale parse (the corpus"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:51` — "// version only moves on managed writes)."
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:87` — "// Pass 1: the migration rewrites; the hook throws to emulate the crash"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:88` — "// between the rewrite and maintenance being requested."
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:95` — "// Pass 2: a fresh manager replays a no-op journal; the pending marker"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:96` — "// must fire the hook exactly once, then clear itself."
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:141` — "// A CLI-only process runs the rewrite with nothing to request maintenance."
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:188` — "// The real hook only ARMS a debounced timer; its promise settles when the"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:189` — "// pass has run. Clearing at request time would lose the re-index to a crash"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:190` — "// or destroy() inside the debounce window (review finding on #3287)."
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:202` — "// A later start still owes it; this time the pass is served."
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:223` — "// Another process takes the migration lock after this run released it and"
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.test.ts:224` — "// arms its own marker before this run's hook returns and its clear starts."
- `packages/remnic-core/src/storage/entity-migration-maintenance-pending.ts:6` — "/** * Issue #3286: the entity migration asks search maintenance to re-index only * after a pass that rewrote references."
