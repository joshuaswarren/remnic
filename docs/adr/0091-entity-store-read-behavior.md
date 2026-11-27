# Entity store reads isolate errors, abort cheaply, and present canonical identities

Status: accepted

## Context
Reading and listing the entity corpus races a background migration (files
rename mid-listing), one unhealthy file must not poison a whole listing, and
abandoned scans must not read every entity file for a result nobody awaits. The
storage god file also had to be decomposed without changing behavior.

## Decision
- Entity reads resolve through the migration journal with a fallback to the
  caller's original id; a vanished listed entry (rename race) resolves through
  historical ids like a direct read. Mutators run locked read-modify-write and
  revalidate resolution BEFORE honoring either verdict — a journal that moved makes
  both the resolution AND a dedupe-based no-op stale. A journal that kept moving
  under the mutation surfaces a retryable error (a silent false would DROP the
  mutation). Dedupe matches against CANONICALIZED stored targets so an existing
  edge still naming the legacy id is not duplicated after the rewrite. A locked
  whole-record rewrite must hold the entity mutation lock, or it would restore
  relationship targets a peer migration rewrote between read and write.
- Listing reports the canonical id for every indexable file so legacy names surface
  as their canonical identity from the start; after a completed journal the on-disk
  filename is authoritative and a late legacy file stays under its own readable
  name; copy-before-unlink windows deduplicate so counts stay correct.
- Error isolation: lock and decrypt failures abort a listing/corpus read (the store
  is unusable or tampered — and a locked store error must propagate, since
  swallowing it would silently return no memories, subtle data loss); anything else
  (EACCES, ENOENT, malformed) fails only that entry. A malformed non-indexable file
  is absent from `files`, and writing its canonical path anyway would replace it
  and then delete fragments holding the only readable copy — so it is not written.
- Corpus reads run in parallel batches of 100 (3000+ files sequentially take 15-20s
  under load; batching keeps fd pressure manageable) and check the abort signal per
  batch, so an abandoned caller stops within one batch. A signal that fired during
  the last batch's await must still surface — otherwise a cancelled or truncated
  scan publishes as complete and is cached as such.
- Entity bodies with text but no name heading stay out of recall (including QMD
  hits); classification is relative to the store root, not path substrings. Entity
  files use `# Name` + `**Type:**` markdown, so retrieval builds a synthetic
  MemoryFile — dated from the `Updated:` line, else file mtime, else epoch — so
  entities participate in boosting and last-recall tracking without inflating
  recency scores.
- Journal table snapshot once per call (per-entry reads are quadratic).
- Under high writer churn the artifact index cache is kept invalid (best-effort
  latest scan returned) so a poisoned rebuild never drops recall entirely.
- God-file decomposition: entity store, timeline helpers (pure functions, no I/O,
  re-exported for API compatibility), identity-continuity store, questions-file
  format, and profile mutation surface were extracted verbatim from storage.ts so
  each stays under structural ratchets; importers take parsing from the subsystem
  module, not the god file.
- `profile.md` carries an OKF v0.1 frontmatter block; profile read-merge-writes are
  bounded short RMWs under a per-dir in-process chain plus the cross-process lock
  (errors propagate so the extraction retry path retains accepted turns).
- The `[Attributes: ...]` enrichment suffix has ONE home: the persisted assembled
  form (suffix appended, then sanitized) is shared by `writeMemory` and
  `composeMemoryEnvelope` so body and write-idempotency fingerprints agree; the
  block must be the final line with no `]` before the closing bracket.
- Subject config rejects a non-object block loudly: a shorthand like
  `subjectClassification: false` must fail, not silently coerce.

## Consequences
Error isolation trades per-entry logging for corpus availability; strict canonical naming can keep legacy filenames visible during migration windows.

## Origin comments
- `packages/remnic-core/src/storage/entity-store.ts:1` — "* * Entity store (extracted from storage.ts StorageManager; god-file * decomposition, #1526 playbook: verbatim move + "
- `packages/remnic-core/src/storage/entity-store.ts:59` — "// Issue #1533 Phase B: importers take entity-file parsing from this storage/"
- `packages/remnic-core/src/storage/entity-store.ts:60` — "// subsystem module, not the storage.ts god file (see check-ratchets.mjs)."
- `packages/remnic-core/src/storage/entity-store.ts:108` — "* * Read an entity file by id, resolving through the migration journal with a * fallback to the caller's original id ("
- `packages/remnic-core/src/storage/entity-store.ts:136` — "* * Locked read-modify-write for the entity-file mutators (issue #2213): * holding the entity-mutation lock keeps `mig"
- `packages/remnic-core/src/storage/entity-store.ts:160` — "// Revalidate BEFORE honoring either verdict: a journal that moved"
- `packages/remnic-core/src/storage/entity-store.ts:161` — "// makes both the resolution AND a dedupe-based no-op stale (a parked"
- `packages/remnic-core/src/storage/entity-store.ts:162` — "// mapping can make \"already present on the claimant\" wrong)."
- `packages/remnic-core/src/storage/entity-store.ts:175` — "// The journal kept moving under us. A silent false would DROP the"
- `packages/remnic-core/src/storage/entity-store.ts:176` — "// requested mutation (the reconcile pass rewrites existing references;"
- `packages/remnic-core/src/storage/entity-store.ts:177` — "// it cannot replay a mutation that was never written) \u2014 surface a"
- `packages/remnic-core/src/storage/entity-store.ts:178` — "// retryable error so the caller's persist machinery logs/retries it."
- `packages/remnic-core/src/storage/entity-store.ts:189` — "// Resolve the target with the SAME snapshot the locked read used, and"
- `packages/remnic-core/src/storage/entity-store.ts:190` — "// dedupe against CANONICALIZED stored targets \u2014 an existing edge the"
- `packages/remnic-core/src/storage/entity-store.ts:191` — "// migration has not rewritten yet still names the legacy id, and a"
- `packages/remnic-core/src/storage/entity-store.ts:192` — "// plain equality check would miss it and leave duplicates after the"
- `packages/remnic-core/src/storage/entity-store.ts:193` — "// rewrite (issue #2213)."
- `packages/remnic-core/src/storage/entity-store.ts:389` — "// Physical hit wins. Miss skips rename/body-scan only when amortized"
- `packages/remnic-core/src/storage/entity-store.ts:390` — "// completion attests live fingerprint inputs (not bare journal.complete)."
- `packages/remnic-core/src/storage/entity-store.ts:405` — "// Deferred / fingerprint-stale: match legacy filename by body id."
- `packages/remnic-core/src/storage/entity-store.ts:424` — "// A peer may have renamed the legacy entry after the directory listing."
- `packages/remnic-core/src/storage/entity-store.ts:515` — "// Journal table snapshot once per call (per-entry reads are quadratic)."
- `packages/remnic-core/src/storage/entity-store.ts:522` — "// Completed journal: the on-disk filename is authoritative; a"
- `packages/remnic-core/src/storage/entity-store.ts:523` — "// late legacy file stays under its own readable name."
- `packages/remnic-core/src/storage/entity-store.ts:525` — "// Both claimants coexisting (copy-before-unlink) keep both names."
- `packages/remnic-core/src/storage/entity-store.ts:532` — "// Report the canonical id for every indexable file so legacy"
- `packages/remnic-core/src/storage/entity-store.ts:533` — "// names surface as their canonical identity from the start."
- `packages/remnic-core/src/storage/entity-store.ts:538` — "// Lock and decrypt errors abort the listing; anything else"
- `packages/remnic-core/src/storage/entity-store.ts:539` — "// (EACCES) fails only this entry \u2014 one unhealthy file must not"
- `packages/remnic-core/src/storage/entity-store.ts:540` — "// empty it."
- `packages/remnic-core/src/storage/entity-store.ts:543` — "// Vanished listed entry: resolve through the journal (rename"
- `packages/remnic-core/src/storage/entity-store.ts:544` — "// race); lstat failures stay within this entry."
- `packages/remnic-core/src/storage/entity-store.ts:557` — "// The copy-before-unlink migration window can snapshot both the legacy"
- `packages/remnic-core/src/storage/entity-store.ts:558` — "// and canonical names; the legacy fallback then resolves to the same"
- `packages/remnic-core/src/storage/entity-store.ts:559` — "// canonical id. Deduplicate so the total stays correct."
- `packages/remnic-core/src/storage/entity-store.ts:574` — "// Read+rewrite under the entity MUTATION lock (issue #2213): an"
- `packages/remnic-core/src/storage/entity-store.ts:575` — "// unlocked whole-record rewrite could restore relationship targets a"
- `packages/remnic-core/src/storage/entity-store.ts:576` — "// peer migration rewrote between the read and the write, and this"
- `packages/remnic-core/src/storage/entity-store.ts:577` — "// path bumps only the status version, which never re-triggers the"
- `packages/remnic-core/src/storage/entity-store.ts:578` — "// completed migration's reference scan."
- `packages/remnic-core/src/storage/entity-store.ts:707` — "// Read all entity files in parallel batches to avoid O(N) sequential I/O."
- `packages/remnic-core/src/storage/entity-store.ts:708` — "// With 3000+ entity files, sequential reads can take 15-20s under load."
- `packages/remnic-core/src/storage/entity-store.ts:709` — "// Batching at 100 keeps file-descriptor pressure manageable while staying fast."
- `packages/remnic-core/src/storage/entity-store.ts:713` — "// Per batch, so an abandoned caller stops within one batch of I/O instead"
- `packages/remnic-core/src/storage/entity-store.ts:714` — "// of reading every entity file for a result nobody awaits (issue #2307)."
- `packages/remnic-core/src/storage/entity-store.ts:723` — "// A listed entry that vanished races a background migration"
- `packages/remnic-core/src/storage/entity-store.ts:724` — "// rename: resolve through historical ids like a direct read."
- `packages/remnic-core/src/storage/entity-store.ts:725` — "// Still-present symlinks/dirs stay skipped."
- `packages/remnic-core/src/storage/entity-store.ts:733` — "// Lock and decrypt failures abort the corpus read (the store"
- `packages/remnic-core/src/storage/entity-store.ts:734` — "// is unusable or tampered); anything else isolates to this entry."
- `packages/remnic-core/src/storage/entity-store.ts:756` — "// A signal that fired during the last batch's await would otherwise publish"
- `packages/remnic-core/src/storage/entity-store.ts:757` — "// and return as if uncancelled (issue #2307 review)."
- `packages/remnic-core/src/storage/entity-store.ts:880` — "// A malformed or otherwise non-indexable file is absent from `files`."
- `packages/remnic-core/src/storage/entity-store.ts:881` — "// Writing the canonical path anyway would replace that file, then"
- `packages/remnic-core/src/storage/entity-store.ts:882` — "// delete the fragments that still hold the only readable copy."
- `packages/remnic-core/src/storage/entity-timeline.ts:1` — "// Entity timeline / structured-section pure helpers extracted from storage.ts"
- `packages/remnic-core/src/storage/entity-timeline.ts:2` — "// (issue #1909 PR write-hot-paths). Pure functions only \u2014 no I/O \u2014 so they are"
- `packages/remnic-core/src/storage/entity-timeline.ts:3` — "// safe to share across the write path and entity parsing without circular"
- `packages/remnic-core/src/storage/entity-timeline.ts:4` — "// runtime coupling. storage.ts imports these back and re-exports the ones that"
- `packages/remnic-core/src/storage/entity-timeline.ts:5` — "// were previously part of its public API."
- `packages/remnic-core/src/storage/identity-continuity-store.ts:1` — "* * Identity-continuity persistence extracted from StorageManager. * * The host keeps the public API while this store "
- `packages/remnic-core/src/storage/memory-read-store.ts:1` — "* * Memory read store (extracted from storage.ts StorageManager; god-file * decomposition, #1526 playbook: verbatim mo"
- `packages/remnic-core/src/storage/memory-read-store.ts:170` — "// Per-entry, so a tree of any shape has a checkpoint: this scan has no"
- `packages/remnic-core/src/storage/memory-read-store.ts:171` — "// in-flight dedup, so every abandoned recall used to start another"
- `packages/remnic-core/src/storage/memory-read-store.ts:172` — "// full walk of it (issue #2307)."
- `packages/remnic-core/src/storage/memory-read-store.ts:186` — "// A cancelled scan must surface, not be swallowed as \"directory doesn't"
- `packages/remnic-core/src/storage/memory-read-store.ts:187` — "// exist yet\" \u2014 otherwise a partial walk would be cached as complete."
- `packages/remnic-core/src/storage/memory-read-store.ts:204` — "// A signal that fired during the last file read of the walk would otherwise"
- `packages/remnic-core/src/storage/memory-read-store.ts:205` — "// publish this scan and return it as if uncancelled (issue #2307 review)."
- `packages/remnic-core/src/storage/memory-read-store.ts:213` — "// Highly concurrent writer churn; keep cache invalid so next read retries a clean rebuild."
- `packages/remnic-core/src/storage/memory-read-store.ts:214` — "// Return best-effort latest scan instead of an empty set to avoid dropping recall entirely."
- `packages/remnic-core/src/storage/memory-read-store.ts:246` — "// A signal that fired during the last directory read would otherwise return a"
- `packages/remnic-core/src/storage/memory-read-store.ts:247` — "// truncated path list as if it were the whole corpus (issue #2307 review)."
- `packages/remnic-core/src/storage/memory-read-store.ts:336` — "// Per batch: an abandoned caller must not keep the scan running (#3139)."
- `packages/remnic-core/src/storage/memory-read-store.ts:470` — "// Entity bodies with text but no name heading stay out of recall,"
- `packages/remnic-core/src/storage/memory-read-store.ts:471` — "// including contextual QMD hits. An empty body still resolves through"
- `packages/remnic-core/src/storage/memory-read-store.ts:472` — "// frontmatter and the canonical filename. A missing type line is still"
- `packages/remnic-core/src/storage/memory-read-store.ts:473` — "// an entity. QMD query behavior is unchanged. Classification is"
- `packages/remnic-core/src/storage/memory-read-store.ts:474` — "// relative to this store root: an absolute path that merely contains"
- `packages/remnic-core/src/storage/memory-read-store.ts:475` — "// an `entities` segment is still an ordinary fact."
- `packages/remnic-core/src/storage/memory-read-store.ts:479` — "// Note: the outer catch intentionally swallows most errors (ENOENT etc.)"
- `packages/remnic-core/src/storage/memory-read-store.ts:480` — "// but SecureStoreLockedError must propagate \u2014 see re-throw below."
- `packages/remnic-core/src/storage/memory-read-store.ts:494` — "// Entity files use a `# Name` + `**Type:** ...` markdown format rather than"
- `packages/remnic-core/src/storage/memory-read-store.ts:495` — "// YAML frontmatter. Build a synthetic MemoryFile so entity files returned by"
- `packages/remnic-core/src/storage/memory-read-store.ts:496` — "// the direct retrieval agent participate in boostSearchResults and last-recall"
- `packages/remnic-core/src/storage/memory-read-store.ts:497` — "// tracking rather than being silently dropped."
- `packages/remnic-core/src/storage/memory-read-store.ts:502` — "// Fall back to file mtime rather than new Date() so that entities without"
- `packages/remnic-core/src/storage/memory-read-store.ts:503` — "// an explicit Updated: timestamp are not treated as freshly created on every"
- `packages/remnic-core/src/storage/memory-read-store.ts:504` — "// read. Using new Date() would inflate boostSearchResults recency scores for"
- `packages/remnic-core/src/storage/memory-read-store.ts:505` — "// every entity that lacks a timestamp."
- `packages/remnic-core/src/storage/memory-read-store.ts:506` — "// Use epoch as the last-resort fallback so that entities without a"
- `packages/remnic-core/src/storage/memory-read-store.ts:507` — "// parseable timestamp don't appear as \"freshly created\" and inflate scores."
- `packages/remnic-core/src/storage/memory-read-store.ts:528` — "// Re-throw store-locked errors \u2014 callers need to distinguish \"locked\""
- `packages/remnic-core/src/storage/memory-read-store.ts:529` — "// from \"file not found / parse error\". Swallowing a locked error here"
- `packages/remnic-core/src/storage/memory-read-store.ts:530` — "// would silently return null and leave the daemon appearing to work"
- `packages/remnic-core/src/storage/memory-read-store.ts:531` — "// while returning no memories (subtle data loss)."
- `packages/remnic-core/src/storage/profile-header.ts:891` — "* * OKF v0.1 profile frontmatter (issue #1946). `profile.md` gains a leading * frontmatter block so the memory directo"
- `packages/remnic-core/src/storage/profile-mutation.ts:4` — "* * Ports over the StorageManager surface the profile mutation domain needs. * Kept as ports so this module stays out "
- `packages/remnic-core/src/storage/profile-mutation.ts:78` — "// Bounded: a profile RMW is a short read-merge-write, never a scan."
- `packages/remnic-core/src/storage/profile-mutation.ts:90` — "// Per-dir in-process chain, then the cross-process lock around the whole"
- `packages/remnic-core/src/storage/profile-mutation.ts:91` — "// RMW: serialized, the second append re-reads after the first's write."
- `packages/remnic-core/src/storage/profile-mutation.ts:92` — "// Errors propagate: the extraction retry path retains the accepted turns."
- `packages/remnic-core/src/storage/questions-file.ts:1` — "* * Question file format (issue #1946 extraction from storage.ts so the * surface file stays under its structural ceil"
- `packages/remnic-core/src/structured-attributes.ts:1` — "/** * Shared helpers for the `\\n[Attributes: \u2026]` enrichment suffix that * `writeMemory` appends to a stored bo"
- `packages/remnic-core/src/structured-attributes.ts:36` — "// The block must be the FINAL line and contain no \"]\" before the"
- `packages/remnic-core/src/structured-attributes.ts:37` — "// closing bracket (mirrors the shape normalizeAttributePairs emits)."
- `packages/remnic-core/src/structured-attributes.ts:56` — "//"
- `packages/remnic-core/src/structured-attributes.ts:57` — "// `writeMemory` historically enriched content with the attribute suffix and"
- `packages/remnic-core/src/structured-attributes.ts:58` — "// then sanitized the COMBINED body inline. That assembly is the persisted"
- `packages/remnic-core/src/structured-attributes.ts:59` — "// form both the file body and write-idempotency fingerprints must agree on"
- `packages/remnic-core/src/structured-attributes.ts:60` — "// (AGENTS.md \u00a713), so it lives here \u2014 shared by `StorageManager.writeMemory`"
- `packages/remnic-core/src/structured-attributes.ts:61` — "// and `composeMemoryEnvelope` \u2014 instead of existing twice."
- `packages/remnic-core/src/structured-attributes.ts:86` — "/** * Assemble the persisted body exactly as `writeMemory` does: append the * normalized attribute suffix when"
- `packages/remnic-core/src/subject-config.ts:1` — "/** * Config parsing for the memory-subject runtime knobs (issue #2372). * * Extracted from config.ts (its str"
- `packages/remnic-core/src/subject-config.ts:30` — "/** * Reject a non-object block loudly (rule 51 / \u00a71): a shorthand like * `subjectClassification: false` must "
