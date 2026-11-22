# Fork lineage is fail-closed on occupied paths, symlink-contained, and written only after successful import

Status: accepted

## Context
Fork imports generate non-deterministic IDs and rewrite file identities; without fail-closed occupancy checks and skip-on-exist, re-imports would silently overwrite user edits. Textual id rewriting avoids full YAML round-tripping, at the cost of only recognizing top-level `id:` keys.

## Decision
Fork mode imports into an isolated `forks/<forkId>/` tree with a lineage breadcrumb, rejecting conflicts before any write.

Rules:
- Any existing filesystem entry at `forks/<forkId>` (directory, file, or symlink, detected via lstat — not stat, so a symlink is caught even if its target is unreadable) is treated as occupied; an earlier directory-only check let a stray file slip past and the later breadcrumb write then failed, leaving a partial fork import after reporting an error.
- The lineage breadcrumb lives under the FORK's own directory (`forks/<forkId>/lineage.json`), not the source capsule's subtree, because forkId may differ from the source capsule id; a subsequent fork of this fork finds the breadcrumb by its own id. The breadcrumb is written only after import completes successfully (never destroy old state before new state is confirmed).
- All lineage writes and reads are symlink-contained: the nearest existing ancestor is realpath-resolved and verified inside the canonical root before any directory creation or write; a symlinked `forks/` pointing outside the root would let even a zero-record capsule escape the sandbox. If the walk reaches the filesystem root without finding anything that exists, the path is harmless and the read simply fails to null.
- `readForkLineage` validates forkId against the capsule-id pattern before any filesystem access (rejecting traversal payloads like `../../etc`) and returns null (not throws) on absence for get-or-default usage; containment is checked via realpath walk plus a defensive lexical relative-path check, and slightly malformed breadcrumbs are parsed leniently (basic shape check, no strict zod) so breadcrumbs missing newer fields are returned rather than silently dropped.
- Skip logic applies to fork mode as well as explicit skip mode for the computed fork path: production imports generate non-deterministic IDs, so re-importing the same capsule must not overwrite user edits in the fork tree or silently change file identities.
- Frontmatter `id:` rewriting is textual, not YAML-parsed: only a top-level `id:` line (column 0, exact key) is replaced, nested ids untouched; the dominant line ending of the first line is detected and preserved (CRLF/LF/CR, LF fallback at EOF) and the trailer after the closing fence is re-emitted verbatim for byte fidelity. Fork-scoped ids use a deterministic sha256 suffix over a sorted-key serialization (capsuleId, originalId, now), independent of object-key order.

## Consequences
See Decision: each rule pairs the constraint that forced it with its cost (extra reads and realpath work, explicit caller options, maintenance of shared helpers and gate regexes). Where topics were merged into this theme as nearest neighbours rather than standalone ADRs, that is noted here: the small single-site topics are absorbed into the theme whose files and failure modes they share.

## Origin comments
- `packages/remnic-core/src/transfer/capsule-fork.ts:129` — "// Treat ANY existing filesystem entry at `forks/<forkId>` as occupied:"
- `packages/remnic-core/src/transfer/capsule-fork.ts:130` — "// directory, regular file, or symlink. A previous version of this check"
- `packages/remnic-core/src/transfer/capsule-fork.ts:131` — "// only rejected directories, so a stray file at the path would slip past"
- `packages/remnic-core/src/transfer/capsule-fork.ts:132` — "// and `importCapsule` would still write under `forks/<sourceCapsule>/...`."
- `packages/remnic-core/src/transfer/capsule-fork.ts:133` — "// The later `mkdir`/`writeFile` for the breadcrumb would then fail,"
- `packages/remnic-core/src/transfer/capsule-fork.ts:134` — "// leaving a partial fork import after reporting an error — violating the"
- `packages/remnic-core/src/transfer/capsule-fork.ts:135` — "// documented "reject before any write" contract (Codex P2 #751 round 2)."
- `packages/remnic-core/src/transfer/capsule-fork.ts:136` — "// `lstat` (not `stat`) is intentional so a symlink at the path is detected"
- `packages/remnic-core/src/transfer/capsule-fork.ts:137` — "// even if its target is missing or otherwise unreadable."
- `packages/remnic-core/src/transfer/capsule-fork.ts:159` — "// The breadcrumb lives under the FORK's own directory, not the source"
- `packages/remnic-core/src/transfer/capsule-fork.ts:160` — "// capsule's fork subtree. `forkId` may differ from `sourceCapsule.id`"
- `packages/remnic-core/src/transfer/capsule-fork.ts:161` — "// (e.g. `forkCapsule({ forkId: "my-fork" })` with source `base-caps`"
- `packages/remnic-core/src/transfer/capsule-fork.ts:162` — "// imports records under `forks/base-caps/` but the lineage breadcrumb"
- `packages/remnic-core/src/transfer/capsule-fork.ts:163` — "// is written to `forks/my-fork/lineage.json` so a subsequent fork of"
- `packages/remnic-core/src/transfer/capsule-fork.ts:164` — "// this fork can locate the breadcrumb by its own id)."
- `packages/remnic-core/src/transfer/capsule-fork.ts:207` — "// Write breadcrumb AFTER import completes successfully — consistent with"
- `packages/remnic-core/src/transfer/capsule-fork.ts:208` — "// gotcha #25 (don't destroy old state before new state is confirmed) and"
- `packages/remnic-core/src/transfer/capsule-fork.ts:209` — "// gotcha #54 (write temp before rename / write before marker)."
- `packages/remnic-core/src/transfer/capsule-fork.ts:245` — "// Reject any forkId that does not satisfy the capsule-id pattern. We use"
- `packages/remnic-core/src/transfer/capsule-fork.ts:246` — "// the same constraints as `forkCapsule` so a path traversal payload like"
- `packages/remnic-core/src/transfer/capsule-fork.ts:247` — "// `../../etc` is rejected before any filesystem access. Returning null"
- `packages/remnic-core/src/transfer/capsule-fork.ts:248` — "// (rather than throwing) keeps the contract symmetric with the"
- `packages/remnic-core/src/transfer/capsule-fork.ts:249` — "// "breadcrumb not present" case for the common get-or-default usage."
- `packages/remnic-core/src/transfer/capsule-fork.ts:289` — "// Basic shape check — we do not run full zod validation here so that"
- `packages/remnic-core/src/transfer/capsule-fork.ts:290` — "// slightly malformed breadcrumbs (e.g. missing new fields added in later"
- `packages/remnic-core/src/transfer/capsule-fork.ts:291` — "// PRs) can still be returned rather than silently dropped."
- `packages/remnic-core/src/transfer/capsule-import.ts:435` — "// Skip logic applies to both `skip` mode (explicit) and `fork` mode"
- `packages/remnic-core/src/transfer/capsule-import.ts:436` — "// (Cursor medium: fork mode must also be skip-on-exist for the computed"
- `packages/remnic-core/src/transfer/capsule-import.ts:437` — "// fork path, because production imports generate non-deterministic IDs —"
- `packages/remnic-core/src/transfer/capsule-import.ts:438` — "// so re-importing the same capsule should not overwrite user edits in the"
- `packages/remnic-core/src/transfer/capsule-import.ts:439` — "// fork tree or silently change file identities by generating new IDs)."
- `packages/remnic-core/src/transfer/capsule-import.ts:593` — "/** * Rewrite a YAML-frontmatter `id:` field to a fork-scoped value. * * Strategy: we deliberately do NOT pars"
- `packages/remnic-core/src/transfer/capsule-import.ts:616` — "// Detect the dominant line ending in the file so we can preserve it when"
- `packages/remnic-core/src/transfer/capsule-import.ts:617` — "// rebuilding the frontmatter delimiters. Splitting/joining on `\n` silently"
- `packages/remnic-core/src/transfer/capsule-import.ts:618` — "// drops `\r` from CRLF files, changing the byte content (Cursor thread #741"
- `packages/remnic-core/src/transfer/capsule-import.ts:619` — "// line 467). We detect the ending of the very first line (the opening `---`)"
- `packages/remnic-core/src/transfer/capsule-import.ts:620` — "// and use that as the canonical separator for the reconstructed delimiters."
- `packages/remnic-core/src/transfer/capsule-import.ts:621` — "// All three cases are covered: CRLF (\r\n), LF (\n), and bare CR (\r)."
- `packages/remnic-core/src/transfer/capsule-import.ts:623` — "// Fall back to LF if the file starts with `---` but has no newline (EOF)."
- `packages/remnic-core/src/transfer/capsule-import.ts:626` — "// Frontmatter block detection: `---` on its own line at the very start,"
- `packages/remnic-core/src/transfer/capsule-import.ts:627` — "// followed by content, followed by `---` on its own line. The closing"
- `packages/remnic-core/src/transfer/capsule-import.ts:628` — "// delimiter must be at column 0. We capture the trailing terminator"
- `packages/remnic-core/src/transfer/capsule-import.ts:629` — "// (`\r?\n` or end-of-string) as a separate group so we can re-emit it"
- `packages/remnic-core/src/transfer/capsule-import.ts:630` — "// verbatim, preserving CRLF/LF/EOF shape from the original file."
- `packages/remnic-core/src/transfer/capsule-import.ts:638` — "// Find a top-level `id:` line. Top-level means the line begins at"
- `packages/remnic-core/src/transfer/capsule-import.ts:639` — "// column 0 inside the frontmatter body (no leading whitespace) and the"
- `packages/remnic-core/src/transfer/capsule-import.ts:640` — "// key is exactly `id`. We deliberately accept `id:` and `id : ` shapes"
- `packages/remnic-core/src/transfer/capsule-import.ts:641` — "// but reject `nested_id:` to avoid touching unrelated keys."
- `packages/remnic-core/src/transfer/capsule-import.ts:648` — "// Reconstruct the file: original prefix (always empty here, fmStart === 0"
- `packages/remnic-core/src/transfer/capsule-import.ts:649` — "// by the `^` anchor) + frontmatter delimiters around the rewritten body."
- `packages/remnic-core/src/transfer/capsule-import.ts:650` — "// Use the detected `eol` for the opening/closing `---` lines so that CRLF"
- `packages/remnic-core/src/transfer/capsule-import.ts:651` — "// files remain CRLF and LF files remain LF, preserving byte-content fidelity"
- `packages/remnic-core/src/transfer/capsule-import.ts:652` — "// (Cursor thread #741 line 467). The captured `fmTrailer` (the newline"
- `packages/remnic-core/src/transfer/capsule-import.ts:653` — "// immediately after the closing `---`, or end-of-string) is re-emitted"
- `packages/remnic-core/src/transfer/capsule-import.ts:654` — "// verbatim so the byte immediately after the closing fence is unchanged."
- `packages/remnic-core/src/transfer/capsule-import.ts:672` — "// Deterministic suffix: short hash of (capsuleId, originalId, now). Using"
- `packages/remnic-core/src/transfer/capsule-import.ts:673` — "// sha256 over a sorted-key serialization (gotcha #38) so the suffix does"
- `packages/remnic-core/src/transfer/capsule-import.ts:674` — "// not depend on Object.entries order."
