# Secure-store encryption binds authenticated metadata into the AEAD, derives keys with memory-hard KDFs, and migrates exactly the memory-bearing directory set

Status: accepted

## Context

An at-rest encryption layer must resist header swapping and truncation, tolerate atomic-rename writes, and be applied to exactly the directories whose contents are sensitive — no more (which would corrupt queue files written through plaintext paths) and no less (which would leave memory categories in plaintext).

## Decision

The envelope header (version byte + per-blob salt) is bound into AES-GCM AAD at seal time, so a header cannot be swapped or transplanted between blobs. The IV length is defensively checked. The header verifier's magic bytes are a constant sealed under the master key at init — randomized magic has no value.

Key derivation uses Argon2id as primary with an scrypt alternative; scrypt maxmem has a 256 MiB ceiling above what N=2^17 needs; cost parameters are validated with full-width checks (no 32-bit truncating `(N & (N-1))` test). AES keys are hard-gated to exactly 32 bytes. Hex parsing rejects odd-length strings rather than silently truncating.

Metadata serializes with sorted top-level keys (JSON.stringify preserves insertion order, so the object is constructed sorted) and reuses one parser for nested validation. Passphrase minimum length is intentionally permissive at 8 chars (phrase-manager users). The CLI reader hardening (PR #737): prompt to stderr, fresh readline per call, streaming UTF-8 decode with final flush, per-chunk (not per-byte-slice) backspace handling, and raw-mode restored afterward. `init` zeroes the derived key and does NOT auto-unlock.

The encryptable set is every recall MEMORY category directory (facts/ plus all CATEGORY_DIR_MAP memory dirs, single-sourced from RECALL_FALLBACK_DIRS) plus artifacts/archive/entities/identity, and state buffer/dropped files (same sensitivity as buffer.json). questions/ is deliberately EXCLUDED: it is written/resolved through plain readFile/writeFile, and sealing it would make resolveQuestion() read ciphertext as UTF-8 and corrupt files while returning success. Readers refuse symlinks and non-regular files before opening, so a poisoned link cannot redirect a probe outside the tree. Entity-file reads tolerate temp-file+rename writes. Tests use cheap but hex-correct scrypt parameters.

## Consequences

questions/ and other queue directories remain plaintext by design — adding a category dir requires updating the shared dir set or it silently writes plaintext. Permissive passphrase length trades brute-force margin for usability.

## Origin comments

- `packages/remnic-core/src/secure-store/cipher.ts:147` — "// Codex P1: bind the envelope header (version + salt) into AAD so"
- `packages/remnic-core/src/secure-store/cipher.ts:162` — "// Defensive: Node always produces 16 bytes when authTagLength is 16."
- `packages/remnic-core/src/secure-store/cipher.ts:241` — "// Codex P1: header (version + salt) is bound at seal time."
- `packages/remnic-core/src/secure-store/cipher.ts:252` — "/** * Build the canonical header AAD: a single byte version followed by * the per-blob salt. Binds the immutab"
- `packages/remnic-core/src/secure-store/cli-handlers.ts:127` — "// Zero the derived key — init does NOT auto-unlock; the operator"
- `packages/remnic-core/src/secure-store/cli-handlers.ts:378` — "/** Minimum passphrase length. 8 chars is intentionally permissive — operators may use phrase managers. */"
- `packages/remnic-core/src/secure-store/entity-file-read.ts:39` — "/** * Atomic-replacement-tolerant variant: entity writes ship as temp-file + * rename, so an open/lstat identi"
- `packages/remnic-core/src/secure-store/header.ts:65` — "/** * Magic bytes sealed under the master key at init time. Constant * across stores — there's no value in ran"
- `packages/remnic-core/src/secure-store/header.ts:133` — "// Inline metadata as a parsed object so it shares the same"
- `packages/remnic-core/src/secure-store/header.ts:179` — "// Codex P2 on PR #737: odd-length hex strings produce a malformed"
- `packages/remnic-core/src/secure-store/header.ts:194` — "// Reuse the metadata parser for nested validation. We re-stringify"
- `packages/remnic-core/src/secure-store/header.ts:226` — "// Enforce even length: odd-length hex is silently truncated by"
- `packages/remnic-core/src/secure-store/index.ts:1` — "/** * Public surface of the secure-store module. * * Issue #690 (PR 1/4) — pure encryption primitives only. No"
- `packages/remnic-core/src/secure-store/kdf.ts:1` — "/** * Key-derivation functions for the secure-store module. * * Issue #690 (PR 1/4) — pure primitives, no I/O."
- `packages/remnic-core/src/secure-store/kdf.ts:91` — "// 256 MiB ceiling — comfortably above the 128 MiB scrypt needs at N=2^17."
- `packages/remnic-core/src/secure-store/kdf.ts:118` — "// Cursor Low + codex P2: a `(N & (N - 1)) !== 0` check truncates"
- `packages/remnic-core/src/secure-store/metadata.ts:160` — "/** * Serialize metadata to a stable JSON string with sorted top-level * keys. Stable ordering matters because"
- `packages/remnic-core/src/secure-store/metadata.ts:168` — "// JSON.stringify preserves insertion order; we construct the object"
- `packages/remnic-core/src/secure-store/metadata.ts:335` — "// Cursor Low + codex P2: bitwise `(N & (N - 1))` truncates to"
- `packages/remnic-core/src/secure-store/metadata.ts:355` — "// Codex P2: cipher.ts hard-requires a 32-byte AES-256 key"
- `packages/remnic-core/src/secure-store/passphrase-reader.ts:51` — "// Codex/Cursor on PR #737: a fresh readline interface per call"
- `packages/remnic-core/src/secure-store/passphrase-reader.ts:82` — "// Non-TTY: line-buffered fallback. Warn once per reader so"
- `packages/remnic-core/src/secure-store/passphrase-reader.ts:92` — "// Codex P1 on PR #737: write the prompt to stderr, not stdout."
- `packages/remnic-core/src/secure-store/passphrase-reader.ts:114` — "// Codex P2 on PR #737: per-chunk `chunk.toString(\"utf8\")` corrupts"
- `packages/remnic-core/src/secure-store/passphrase-reader.ts:125` — "// Flush any remaining bytes the decoder is holding so trailing"
- `packages/remnic-core/src/secure-store/passphrase-reader.ts:128` — "// Restore the prior raw-mode state so we don't strand the parent shell"
- `packages/remnic-core/src/secure-store/passphrase-reader.ts:164` — "// Cursor on PR #737: `buffer.slice(0, -1)` deletes one UTF-16"
- `packages/remnic-core/src/secure-store/secure-fs.ts:676` — "// A canonical-AAD stage read (offline-sync generation transaction) binds"
- `packages/remnic-core/src/secure-store/secure-fs.ts:677` — "// the FINAL published path, not the physical staging path."
- `packages/remnic-core/src/secure-store/secure-fs.ts:863` — "// Every recall MEMORY category directory (facts/ + the CATEGORY_DIR_MAP memory"
- `packages/remnic-core/src/secure-store/secure-fs.ts:864` — "// dirs) must be encryptable at rest — #1546 routes decision/preference/moment/..."
- `packages/remnic-core/src/secure-store/secure-fs.ts:865` — "// memories into their own dirs, so hardcoding only facts/corrections/procedures/"
- `packages/remnic-core/src/secure-store/secure-fs.ts:866` — "// reasoning-traces would silently write those categories in plaintext on"
- `packages/remnic-core/src/secure-store/secure-fs.ts:867` — "// encrypted stores. RECALL_FALLBACK_DIRS is the single source of truth for that"
- `packages/remnic-core/src/secure-store/secure-fs.ts:868` — "// set; the extra non-category markdown roots (artifacts/archive/entities/"
- `packages/remnic-core/src/secure-store/secure-fs.ts:869` — "// identity) are appended."
- `packages/remnic-core/src/secure-store/secure-fs.ts:870` — "//"
- `packages/remnic-core/src/secure-store/secure-fs.ts:871` — "// questions/ is deliberately EXCLUDED (RECALL_FALLBACK_DIRS omits the non-memory"
- `packages/remnic-core/src/secure-store/secure-fs.ts:872` — "// queue dirs): the question queue is written/resolved through plain readFile/"
- `packages/remnic-core/src/secure-store/secure-fs.ts:873` — "// writeFile (StorageManager.writeQuestion/resolveQuestion), NOT the secure-file"
- `packages/remnic-core/src/secure-store/secure-fs.ts:874` — "// helpers. Encrypting questions/ here would make migration seal those files,"
- `packages/remnic-core/src/secure-store/secure-fs.ts:875` — "// after which resolveQuestion() would read ciphertext as UTF-8, fail to update"
- `packages/remnic-core/src/secure-store/secure-fs.ts:876` — "// the frontmatter, and overwrite/corrupt the file while returning success"
- `packages/remnic-core/src/secure-store/secure-fs.ts:877` — "// (codex #1563 review). Keeping questions/ plaintext preserves the queue's"
- `packages/remnic-core/src/secure-store/secure-fs.ts:878` — "// existing behavior; #1546 does not change question encryption."
- `packages/remnic-core/src/secure-store/secure-fs.ts:905` — "// state/dropped/ holds copies of extraction-buffer turns dropped after"
- `packages/remnic-core/src/secure-store/secure-fs.ts:906` — "// repeated extraction failures — same content sensitivity as buffer.json."
- `packages/remnic-core/src/secure-store/secure-fs.ts:910` — "/** * Per-session buffer state files (`state/buffer/<session>.json`) hold the same * buffered turns the legacy `state"
- `packages/remnic-core/src/secure-store/secure-store.test.ts:1` — "/** * Tests for the secure-store encryption primitives (issue #690 PR 1/4). * * These tests are pure: no I/O, no cloc"
- `packages/remnic-core/src/secure-store/secure-store.test.ts:83` — "/** Cheap scrypt params for tests — still hex-correct but ~milliseconds. */"
- `packages/remnic-core/src/secure-store/secure-store.test.ts:964` — "// #1546 routes decision/preference/... memories into their own dirs, which"
- `packages/remnic-core/src/secure-store/secure-store.test.ts:965` — "// must be encryptable at rest. But questions/ is written/resolved via plain"
- `packages/remnic-core/src/secure-store/secure-store.test.ts:966` — "// readFile/writeFile (writeQuestion/resolveQuestion), so encrypting it would"
- `packages/remnic-core/src/secure-store/secure-store.test.ts:967` — "// make resolveQuestion() read ciphertext as UTF-8 and corrupt the file"
- `packages/remnic-core/src/secure-store/secure-store.test.ts:968` — "// (codex #1563 review). Migration must seal decisions/ but skip questions/."
- `packages/remnic-core/src/secure-store/secure-store.test.ts:1046` — "// A symlink (even to a regular file) is REFUSED before opening — a poisoned"
- `packages/remnic-core/src/secure-store/secure-store.test.ts:1047` — "// link must never redirect the probe outside our tree (#2033)."
