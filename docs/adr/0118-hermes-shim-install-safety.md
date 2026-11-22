# Hermes shim install only ever writes marker-identified files and rejects unsafe roots

Status: accepted

## Context
The shim lives inside a user-controlled Hermes home (possibly pointed at by an externally supplied HERMES_HOME). A symlinked root could redirect config/shim writes and deletions to an arbitrary directory; a tampered connector.json could point cleanup at any file; and an unreadable file cannot be classified as ours versus user-authored, so deletion heuristics could destroy user work.

## Decision
Install and cleanup are guarded at every boundary: an explicitly supplied HERMES_HOME that is a symlink or not a directory is rejected outright; every path component between the Hermes root and the shim file is checked for symlinks; cleanup only ever touches a path with the exact generated-shim shape, and only strips the marker `remnic:` block; a file whose content cannot be read or positively identified as Remnic's is never modified or deleted (fail closed) - an unreadable existing marker shim surfaces the read failure so the caller emits the manual hint instead of silently skipping a reinstall. The platform-default root is normalized without treating it as hostile external input in the same way, and writes of non-secret shim files are atomic with 0o644 permissions. The shim content always includes the literal discovery keywords (`register_memory_provider` / `MemoryProvider`) because Hermes discovers providers by text scan, and no shell one-liner is emitted since paths may contain characters that break quoting.

## Consequences
Installs into exotic layouts (custom basenames, no Hermes siblings) are only accepted when the target file currently carries the remnic marker, which bounds what a tampered path can affect. Fail-closed means some recoverable situations surface as errors requiring manual intervention rather than being silently skipped.

## Origin comments
- `packages/remnic-core/src/connectors/hermes-shim.ts:52` — "// lstat (no symlink following): an externally supplied HERMES_HOME that is"
- `packages/remnic-core/src/connectors/hermes-shim.ts:53` — "// a symlink could redirect config/shim writes and deletions to an"
- `packages/remnic-core/src/connectors/hermes-shim.ts:54` — "// arbitrary directory — reject symlinked roots outright, matching the"
- `packages/remnic-core/src/connectors/hermes-shim.ts:55` — "// repository's symlink-traversal guard for directory scans (Codex P1 on"
- `packages/remnic-core/src/connectors/hermes-shim.ts:56` — "// PR #1938, round 15). A non-directory (regular file) root is likewise a"
- `packages/remnic-core/src/connectors/hermes-shim.ts:57` — "// misconfiguration."
- `packages/remnic-core/src/connectors/hermes-shim.ts:82` — "/** * Normalize the platform-default Hermes root. Unlike an explicitly supplied * `HERMES_HOME` (external input — symlin"
- `packages/remnic-core/src/connectors/hermes-shim.ts:104` — "/** * Atomically write a plain (non-secret) file with 0o644 permissions. The shim * carries no credentials, so unlike `w"
- `packages/remnic-core/src/connectors/hermes-shim.ts:123` — "best-effort on non-POSIX filesystems"
- `packages/remnic-core/src/connectors/hermes-shim.ts:137` — "/** * Reject symlinked path components between the Hermes root and the shim file * (`plugins/`, `plugins/remnic/`, and t"
- `packages/remnic-core/src/connectors/hermes-shim.ts:178` — "// An unreadable existing file cannot be classified as ours vs"
- `packages/remnic-core/src/connectors/hermes-shim.ts:179` — "// user-authored. Treating it as user-authored would silently skip a"
- `packages/remnic-core/src/connectors/hermes-shim.ts:180` — "// reinstall of OUR marker shim (Bugbot on PR #1938); surface the read"
- `packages/remnic-core/src/connectors/hermes-shim.ts:181` — "// failure instead so the caller emits the manual hint."
- `packages/remnic-core/src/connectors/hermes-shim.ts:246` — "// Record create-vs-overwrite BEFORE writing: a rollback must never delete"
- `packages/remnic-core/src/connectors/hermes-shim.ts:247` — "// a shim that pre-existed this reconcile (e.g. connector JSON deleted"
- `packages/remnic-core/src/connectors/hermes-shim.ts:248` — "// manually while the marker shim survived) — overwriting our own"
- `packages/remnic-core/src/connectors/hermes-shim.ts:249` — "// deterministic content is a no-op, but deleting it would break a"
- `packages/remnic-core/src/connectors/hermes-shim.ts:250` — "// functional install (Codex P2 on PR #1938, round 7)."
- `packages/remnic-core/src/connectors/hermes-shim.ts:254` — "// A collision with a user-authored file writes nothing: treat it as an"
- `packages/remnic-core/src/connectors/hermes-shim.ts:255` — "// unconfirmed replacement so the prior generated shim is NOT cleaned and"
- `packages/remnic-core/src/connectors/hermes-shim.ts:256` — "// the registry keeps pointing at the shim that actually works"
- `packages/remnic-core/src/connectors/hermes-shim.ts:257` — "// (Codex P2 on PR #1938, round 8)."
- `packages/remnic-core/src/connectors/hermes-shim.ts:262` — "// No shell one-liner here: the path may contain characters that break"
- `packages/remnic-core/src/connectors/hermes-shim.ts:263` — "// quoting, and the shim content MUST include the literal text"
- `packages/remnic-core/src/connectors/hermes-shim.ts:264` — "// `register_memory_provider` (or `MemoryProvider`) or Hermes' discovery"
- `packages/remnic-core/src/connectors/hermes-shim.ts:265` — "// text-scan skips the directory (PR #1938 review)."
- `packages/remnic-core/src/connectors/hermes-shim.ts:271` — "// Nothing new confirmed on disk — keep tracking ONLY what the registry"
- `packages/remnic-core/src/connectors/hermes-shim.ts:272` — "// already pointed at. Never persist the unconfirmed target: provenance"
- `packages/remnic-core/src/connectors/hermes-shim.ts:273` — "// must reference a Remnic shim that actually exists (Bugbot on PR #1938,"
- `packages/remnic-core/src/connectors/hermes-shim.ts:274` — "// round 8)."
- `packages/remnic-core/src/connectors/hermes-shim.ts:286` — "// The prior install's shim lives elsewhere (HERMES_HOME changed). Compare"
- `packages/remnic-core/src/connectors/hermes-shim.ts:287` — "// by resolved file identity, not string equality — two spellings of the"
- `packages/remnic-core/src/connectors/hermes-shim.ts:288` — "// same directory (symlinks, case-insensitive volumes, tilde vs absolute)"
- `packages/remnic-core/src/connectors/hermes-shim.ts:289` — "// must not delete the shim that was just written (Bugbot on PR #1938,"
- `packages/remnic-core/src/connectors/hermes-shim.ts:290` — "// round 7). Clean it now that the replacement is confirmed; marker-gating"
- `packages/remnic-core/src/connectors/hermes-shim.ts:291` — "// inside removeHermesShim protects user-authored files."
- `packages/remnic-core/src/connectors/hermes-shim.ts:342` — "// Only ever touch a path with the exact generated-shim shape. The"
- `packages/remnic-core/src/connectors/hermes-shim.ts:343` — "// persisted candidate comes from connector.json, which is on-disk state —"
- `packages/remnic-core/src/connectors/hermes-shim.ts:344` — "// do not let a tampered value point this cleanup at an arbitrary file."
- `packages/remnic-core/src/connectors/hermes-shim.ts:361` — "// Fail safe: an unreadable file cannot be verified as ours — never"
- `packages/remnic-core/src/connectors/hermes-shim.ts:362` — "// delete what we cannot positively identify."
- `packages/remnic-core/src/connectors/hermes-shim.ts:373` — "// One stale/unwritable candidate must not abort cleanup of the rest"
- `packages/remnic-core/src/connectors/hermes-shim.ts:374` — "// (Codex P2 on PR #1938, round 20). The failed path stays on disk and,"
- `packages/remnic-core/src/connectors/hermes-shim.ts:375` — "// still carrying the marker, remains tracked by the provenance"
- `packages/remnic-core/src/connectors/hermes-shim.ts:376` — "// reconciliation for a later retry."
- `packages/remnic-core/src/connectors/hermes-shim.ts:444` — "// Last resort for custom HERMES_HOME dirs with an arbitrary basename and no"
- `packages/remnic-core/src/connectors/hermes-shim.ts:445` — "// Hermes-layout siblings (e.g. shim materialization failed so plugins/ was"
- `packages/remnic-core/src/connectors/hermes-shim.ts:446` — "// never created): accept the path when the file itself currently carries a"
- `packages/remnic-core/src/connectors/hermes-shim.ts:447` — "// top-level remnic: block — cleanup only ever strips that block, so the"
- `packages/remnic-core/src/connectors/hermes-shim.ts:448` — "// content check bounds what a tampered path could affect (Bugbot on"
- `packages/remnic-core/src/connectors/hermes-shim.ts:449` — "// PR #1938, round 9)."
