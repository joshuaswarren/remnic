# One atomic file per buffer session with strict symlink and limit guards

Status: accepted

## Context
Buffered conversation data is sensitive and per-session; one file per session
keeps the observe hot path from rewriting unrelated sessions, but file naming,
symlinks, atomicity, and partial drain states all create failure modes where data
escapes the tree or a live drainer's claim gets destroyed.

## Decision
- Session files live one per buffer session under `<stateDir>/buffer/`, named by
  the lowercase hex SHA-256 of the buffer key under a fixed prefix: case-independent
  and collision-free.
- Refuse a symlinked buffer directory and never follow a symlink inside it: buffered
  conversation data (and deletions) must not be sent outside the state tree.
- Persist each session atomically as compact JSON — machine-read state, and
  pretty-printing a large buffer costs CPU and bytes.
- Consume a drain tombstone ONLY when the drain finished (acked, nothing pending,
  no lease). Partial `drained` means chunks completed but the drainer may still be
  running; releasing then would unlink its claim and turn its later writes into
  no-ops. On a finished drain, write the owner's fresh remainder back as a session
  file — subtracting the drained turns here so a caller that did not subtract them
  cannot resurrect them — then release the tombstone.
- Reading a whole buffer migrates a legacy buffer.json once; a per-session file that
  parsed wins over the legacy file. Locked stores or wrong keys are NOT corrupt
  files — reading them as empty would let later saves replace the real encrypted
  session. Genuinely corrupt files are skipped and logged so one bad file cannot
  nuke the other sessions.
- Reconciling the directory with a whole buffer state writes every entry, then
  deletes files for keys no longer present.
- Dropped extraction chunk copies get a random suffix so copies written in the same
  millisecond (or for keys truncating to the same name) cannot overwrite each other.
- Row-limit parameters: a non-finite/non-positive `limit` returns no rows; callers
  wanting everything OMIT the key. `Infinity` is rejected (ambiguous slice math) and
  fractional values <1 are guarded so `slice(-0)` cannot return the entire file.
  Slice over VALID rows, not raw lines, so a malformed tail cannot mask good data,
  and sort by event timestamp before slicing.
- The questions cache is invalidated by the questions directory mtime, so a question
  written or resolved by another process is detected immediately.

## Consequences
Per-session files cost one file stat per session on bulk operations; strict symlink refusal can make an externally-reorganized state dir unreadable by design.

## Origin comments
- `packages/remnic-core/src/storage/buffer-session-files.ts:31` — "/** * Case-independent, collision-free file name for a buffer key: the lowercase * hex SHA-256 of the key under a fixed "
- `packages/remnic-core/src/storage/buffer-session-files.ts:87` — "/** * One file per buffer session under `<stateDir>/buffer/`, so the observe hot * path persists only the session that c"
- `packages/remnic-core/src/storage/buffer-session-files.ts:188` — "/** * Refuse a symlinked buffer directory: following it would send buffered * conversation data (and deletions) outside "
- `packages/remnic-core/src/storage/buffer-session-files.ts:208` — "/** Persist ONE session atomically. Compact JSON: machine-read state, and * pretty-printing a large buffer costs CPU and"
- `packages/remnic-core/src/storage/buffer-session-files.ts:213` — "// Consume the tombstone ONLY when the drain finished (acked: extracted"
- `packages/remnic-core/src/storage/buffer-session-files.ts:214` — "// turns recorded, nothing pending, no lease). Partial `drained` just"
- `packages/remnic-core/src/storage/buffer-session-files.ts:215` — "// means chunks completed \u2014 the drainer may still be running, and"
- `packages/remnic-core/src/storage/buffer-session-files.ts:216` — "// releasing here would unlink its claim and turn its later writes into"
- `packages/remnic-core/src/storage/buffer-session-files.ts:217` — "// no-ops."
- `packages/remnic-core/src/storage/buffer-session-files.ts:220` — "// The drain finished this session: the claim is a tombstone. Write"
- `packages/remnic-core/src/storage/buffer-session-files.ts:221` — "// the owner's fresh remainder back as a session file (the drained"
- `packages/remnic-core/src/storage/buffer-session-files.ts:222` — "// turns are subtracted here too, so a caller that did not subtract"
- `packages/remnic-core/src/storage/buffer-session-files.ts:223` — "// them cannot resurrect them) and release the tombstone."
- `packages/remnic-core/src/storage/buffer-session-files.ts:256` — "// Regular files only: a symlink inside the directory is never followed."
- `packages/remnic-core/src/storage/buffer-session-files.ts:264` — "/** Read every per-session file. Corrupt files are skipped (and logged) so * one bad file cannot nuke the other sessions"
- `packages/remnic-core/src/storage/buffer-session-files.ts:280` — "// A locked store or a wrong key is not a corrupt file: reading it as empty would let"
- `packages/remnic-core/src/storage/buffer-session-files.ts:281` — "// later saves replace the real encrypted session."
- `packages/remnic-core/src/storage/buffer-session-files.ts:317` — "/** * Load the whole buffer, migrating a legacy buffer.json once. A per-session * file that parsed wins over the legacy "
- `packages/remnic-core/src/storage/buffer-session-files.ts:351` — "/** * Reconcile the files with a WHOLE buffer state: write every entry, then * delete files for keys no longer present. "
- `packages/remnic-core/src/storage/dropped-extraction-chunk.ts:21` — "// The random suffix keeps copies written in the same millisecond (or for keys that truncate to the same name) from"
- `packages/remnic-core/src/storage/dropped-extraction-chunk.ts:22` — "// overwriting each other."
- `packages/remnic-core/src/storage/memory-read-store.ts:615` — "// Resolve the effective limit up front. Any non-finite / non-positive"
- `packages/remnic-core/src/storage/memory-read-store.ts:616` — "// value returns no rows \u2014 callers who want \"everything\" should OMIT"
- `packages/remnic-core/src/storage/memory-read-store.ts:617` — "// the `limit` key (treated as \"no bound\" below). We intentionally"
- `packages/remnic-core/src/storage/memory-read-store.ts:618` — "// reject `Infinity` too, because the slice math `events.slice(-Inf)`"
- `packages/remnic-core/src/storage/memory-read-store.ts:619` — "// is surprising and ambiguous; omit the key instead. Fractional"
- `packages/remnic-core/src/storage/memory-read-store.ts:620` — "// values <1 floor to 0, which would make `slice(-0)` return the"
- `packages/remnic-core/src/storage/memory-read-store.ts:621` — "// entire file \u2014 guard against that too."
- `packages/remnic-core/src/storage/memory-read-store.ts:656` — "// Slice over VALID rows, not raw lines, so malformed tails cannot"
- `packages/remnic-core/src/storage/memory-read-store.ts:657` — "// mask good data above them. Sort by event timestamp before slicing"
- `packages/remnic-core/src/storage/memory-read-store.ts:658` — "// so concurrent probe completion order cannot make an older scored"
- `packages/remnic-core/src/storage/memory-read-store.ts:659` — "// turn look newer than a later scored turn."
- `packages/remnic-core/src/storage/memory-read-store.ts:784` — "// Check dir mtime for cross-process invalidation \u2014 if another process"
- `packages/remnic-core/src/storage/memory-read-store.ts:785` — "// wrote/resolved a question, the directory mtime will be newer than loadedAt."
