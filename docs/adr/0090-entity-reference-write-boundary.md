# Entity references canonicalize at the write boundary under strict symlink discipline

Status: accepted

## Context
The migration journal can move entity ids at any moment, including between a
writer resolving a ref and persisting. Untrusted local files may be symlinks
planted to redirect reads/writes outside the memory tree. Ordinary entity reads
must also never follow a symlink at `entities/<id>.md` to content outside the
tree.

## Decision
- The write boundary canonicalizes `entityRef` on every memory write (frontmatter
  and raw `entityRef:` lines), before the write lands, and re-checks after persist:
  if the journal moved across the await, the caller's ORIGINAL ref is re-resolved
  and repaired under the final claimant. Sync callers that cannot take the async
  mutation lock canonicalize through the sync variant. Non-string refs pass through
  untouched — this boundary canonicalizes ids, it does not take over input
  validation the write path never performed.
- The journal's mapping table and completion view are keyed by the journal FILE's
  identity (same opened inode as the content, opened without following symlinks),
  so a long-lived manager never canonicalizes against a stale table. Never follow a
  symlinked/non-regular journal or adopt its identity — serve the last-known table.
  A TRANSIENT open/read failure (EACCES/EIO) must not degrade to an empty table: a
  write during the outage would skip canonicalization AND pass the post-write
  identity check. Only a genuine ENOENT means "no journal". A parse failure under a
  valid identity does not commit the key (the next lookup retries). A document
  without a valid `mappings` object is a legitimately empty journal, and parsed
  tables use null prototypes so journal-supplied ids like `constructor` are own
  entries, never prototype collisions; lookups check own properties only.
- Never write THROUGH a symlinked marker or symlinked state dir: the parent is
  lstat-verified as a real directory, and temp-file-plus-rename replaces a planted
  link itself rather than following it. The parent is revalidated between the temp
  write and publication, reducing check-then-use to the rename primitive's own
  atomicity. Marker writes are best-effort by design: a marker failure must not
  fail the restore/sync that requested it.
- Tombstones canonicalize their identity fields at the append chokepoint against
  the CURRENT journal, then recheck — a peer publishing a newer journal between
  read and append must not leave a tombstone naming a stale id.
- The resurrection gate is fail-open and add-only, re-run under the FINAL ref
  before rewrite, checking EVERY derived key (emitters register one tombstone per
  key, so the block can be on any of them). A lookup error must not block the
  write; a repair rewrite of a tombstone-blocked record keeps the blocked-capture
  index consistent. Projection rows written under a pre-repair claimant cannot be
  restored once the mapping is parked.
- Metadata frontmatter writes may suppress the mention epoch only when the file
  still has the same body and entityRef.
- Within a trusted entities root, readdir directly so planted entries reach the
  secure read instead of being swallowed by listing guards; a symlinked/replaced
  root resolves empty rather than being followed.

## Consequences
Canonicalization on every write costs a journal read/identity check per write; transient journal failures surface as errors instead of silently skipping canonicalization.

## Origin comments
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:2` — "/** * Write-boundary surface of the entity canonical-id migration (issue #2213). * * The migration itself (entity-canoni"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:42` — "/** * Parse a journal document into a mapping table. A document without a valid * `mappings` object is a LEGITIMATELY em"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:52` — "// Null prototype: journal-supplied ids like `constructor` must be own"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:53` — "// entries, never collide with Object.prototype (Codex P2, round 20)."
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:65` — "/** Whether the journal says its migration completed. Throws like the mapping parser. */"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:78` — "/** * Open the journal WITHOUT following symlinks and read content + identity * from the same opened inode (repo rule: r"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:149` — "/** * Append a tombstone with its identity canonicalized against the CURRENT * journal, then recheck: a peer publishing "
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:201` — "/** * Journal mapping table keyed by the journal FILE's identity, so a long-lived * StorageManager never canonicalizes a"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:227` — "/** * Memoized journal-completion view keyed on the journal file's stat identity. * entityList consults completion once "
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:271` — "// Symlinked/non-regular journal: never follow it, never adopt its"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:272` — "// identity \u2014 serve this store's last-known table. If it later becomes"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:273` — "// a regular file its identity differs from the stored key and reloads."
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:278` — "// A TRANSIENT open/read failure (EACCES/EIO) must not dump a valid"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:279` — "// table for {}: a write during the outage would skip canonicalization"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:280` — "// AND its post-write identity check would compare equal. Serve this"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:281` — "// store's last-known table; only a genuine ENOENT means \"no journal\"."
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:293` — "// Parse failed under a VALID identity: do not commit the key \u2014"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:294` — "// the next lookup retries instead of pinning an empty table."
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:315` — "// Own properties only: an unmapped id like `constructor` must not read"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:316` — "// Object.prototype and return a function (Codex P2, round 20)."
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:324` — "/** * Canonicalize the `entityRef` a memory-write caller supplied (issue #2213). * * Extraction and capture callers pass"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:338` — "// Non-strings (absent, or a JS caller's null/junk) pass through untouched:"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:339` — "// this boundary canonicalizes ids, it does not take over input validation"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:340` — "// the write path never performed \u2014 serialization already drops falsy refs."
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:345` — "/** * Canonicalize the effective `entityRef:` line inside a raw memory record's * leading frontmatter block (issue #2213"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:417` — "// Never write THROUGH a symlinked marker OR a symlinked state dir (repo"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:418` — "// rule: reject symlink traversal from memory directories). The parent is"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:419` — "// lstat-verified as a real directory \u2014 direct restore/import callers can"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:420` — "// reach this helper without validateRoots() \u2014 and temp-file-plus-rename"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:421` — "// handles the final component: rename() replaces a planted link ITSELF"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:422` — "// rather than following it, with no O_NOFOLLOW dependency."
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:430` — "// Revalidate the parent between the temp write and publication (Codex"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:431` — "// P2, round 20): a state-dir swapped for a symlink after the check above"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:432` — "// would have landed the temp file through the link. Node has no openat,"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:433` — "// so the residual window is the realpath\u2192rename gap \u2014 this recheck"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:434` — "// reduces check-then-use to the platform primitive's own atomicity."
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:455` — "/** * Post-persist TOCTOU guard (issue #2213). A writer resolves `entityRef` * against one journal generation, then awai"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:482` — "/** * Classify a raw write target for entity-reference handling (issue #2213): * - `\"memory\"` \u2014 hot recall / cold / arch"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:509` — "/** * Canonicalize a tombstone's identity fields at the append chokepoint * (issue #2213): emitters (forget, temporal su"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:540` — "/** * Post-persist repair (issue #2213): when the journal moved across a persist, * re-resolve the caller's ORIGINAL ref"
- `packages/remnic-core/src/storage/entity-canonical-id-references.ts:610` — "/** * Sync variant (space promotion, curation, review actions). Sync callers * cannot take the async mutation lock, so e"
- `packages/remnic-core/src/storage/entity-mention-frontmatter-hold.ts:16` — "/** * Metadata frontmatter writes may suppress the mention epoch only when the * file still has the same body, entityRef"
- `packages/remnic-core/src/storage/entity-ref-repair.ts:1` — "/** * Post-persist entity-reference repair (issue #2213), extracted from * storage.ts (#1520 god-file ratchet). * * Ever"
- `packages/remnic-core/src/storage/entity-ref-repair.ts:44` — "/** Re-run the add-only resurrection gate under the FINAL ref before the * rewrite (chunk writes, where `body` IS the ha"
- `packages/remnic-core/src/storage/entity-ref-repair.ts:56` — "/** * Shared lookup+apply core for the write-time resurrection gate (#1579 / * #2213): fail-open, add-only; writeMemory'"
- `packages/remnic-core/src/storage/entity-ref-repair.ts:69` — "// Pass EVERY derived key (thread Ociag/Oci-W): emitters register one"
- `packages/remnic-core/src/storage/entity-ref-repair.ts:70` — "// tombstone per key, so the block can be on any of them."
- `packages/remnic-core/src/storage/entity-ref-repair.ts:87` — "// Fail-open (rule 34): a lookup error must not block the write."
- `packages/remnic-core/src/storage/entity-ref-repair.ts:114` — "// Blocked-capture surface: a repair rewrite of a tombstone-blocked"
- `packages/remnic-core/src/storage/entity-ref-repair.ts:115` — "// record must keep TombstoneBlockedCaptureIndex consistent."
- `packages/remnic-core/src/storage/entity-ref-repair.ts:155` — "/** * Projection rows written under the pre-repair claimant cannot be restored * once the mapping is parked (Codex P1). "
- `packages/remnic-core/src/storage/entity-store-symlink.test.ts:9` — "/** * COS-388c Finding C2: ordinary entity reads must not follow a symlink at * `entities/<id>.md` to content outside th"
- `packages/remnic-core/src/storage/entity-store.ts:691` — "// A symlinked/replaced entities root has no readable entries (merged"
- `packages/remnic-core/src/storage/entity-store.ts:692` — "// #3207 semantics): resolve empty rather than following it. Within a"
- `packages/remnic-core/src/storage/entity-store.ts:693` — "// trusted root, readdir directly so planted entries reach the secure"
- `packages/remnic-core/src/storage/entity-store.ts:694` — "// read instead of being swallowed by the listing guards."
