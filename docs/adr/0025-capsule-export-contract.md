# Capsule export is deterministic, rejects ambiguous inputs, and treats transcripts and output locations explicitly

Status: accepted

## Context
Ambiguous inputs (empty filters, overflowing dates, outDir at the root) either fail silently or corrupt incremental exports; the contract rejects them loudly. Costs: callers must pass explicit options, and legacy-compat fields are derived rather than independently maintained.

## Decision
Capsule export enforces an explicit, unambiguous contract at the entrypoint and produces a deterministic single artifact.

Rules:
- The export root must be a directory (existsSync is true for files; the walk would silently succeed with zero entries); `outDir === root` is rejected (the scan would silently succeed with an empty manifest/archive — a data-loss footgun) and an outDir inside the root is excluded from the scan so re-runs never re-package prior `.capsule.json.gz` archives and sidecar manifests.
- An empty `includeKinds` array means "include nothing", never "include all" — modeled as an explicit empty allow-list rather than a throw because empty capsules are valid. Transcripts are opt-in via `includeTranscripts: true` (or explicit includeKinds listing) so callers don't hard-code kind lists that would inadvertently drop new memory dirs like `peers/` or `forks/`. Files at the repo root are excluded under an explicit allow-list (uncategorized).
- `since` accepts exactly two strict ISO-8601 shapes (date-only and offset datetime); calendar overflow (e.g. 2026-02-31, silently normalized by Date.parse into March 3) is rejected by comparing the input's stated wall-clock components — for explicit non-zero offsets compare against that offset's wall-clock, not UTC. Silent coercion of an exact time boundary breaks incremental exports. The CLI date overflow check likewise compares local-time, not UTC, components. `isCalendarDateValid` stays internal — only `parseStrictCliDate` is public API.
- The archive is a single gzip'd JSON bundle (JSON encoded before gzip so it is opaque to file-tree filtering; the sync helper keeps the function pure async) with a sidecar manifest for cheap inspection without decompression. When `encrypt` is set, the plaintext gzip is wrapped in a REMNIC-ENC sealed envelope and the plaintext is removed only AFTER the encrypted file was written successfully, so a crash mid-encrypt cannot destroy the only copy. Import auto-detects encryption only from a definitive `.enc` suffix or REMNIC-ENC magic header, never on ambiguous content.
- When the structured `parent` is supplied without `parentCapsule`, the legacy field is derived from it so manifests satisfy the documented invariant for legacy V2 readers; an explicit `parentCapsule` override (including explicit null) still wins for migration scenarios. Capsule-block overrides are re-parsed with the same zod schema as hand-built blocks. Training-export collection iterates the shared RECALL_FALLBACK_DIRS list (single source of truth) so newly-routed categories (decisions/, preferences/) are exported, while entities/ stays a separate opt-in include; its frontmatter parsing mirrors storage.ts but is kept standalone.
- Export file collection is deterministic: lexicographically sorted absolute paths, stable final sort, independent of readdir ordering across filesystems.

## Consequences
See Decision: each rule pairs the constraint that forced it with its cost (extra reads and realpath work, explicit caller options, maintenance of shared helpers and gate regexes). Where topics were merged into this theme as nearest neighbours rather than standalone ADRs, that is noted here: the small single-site topics are absorbed into the theme whose files and failure modes they share.

## Origin comments
- `packages/remnic-core/src/transfer/capsule-export.ts:164` — "// `includeTranscripts: true` overrides the default transcripts exclusion"
- `packages/remnic-core/src/transfer/capsule-export.ts:165` — "// without requiring an explicit `includeKinds` list — so callers that want"
- `packages/remnic-core/src/transfer/capsule-export.ts:166` — "// all memory dirs + transcripts don't need to hard-code a list that would"
- `packages/remnic-core/src/transfer/capsule-export.ts:167` — "// inadvertently drop new dirs like `peers/` or `forks/`. (Cursor / #747)"
- `packages/remnic-core/src/transfer/capsule-export.ts:461` — "// Transcripts are opt-in: excluded unless caller explicitly listed them"
- `packages/remnic-core/src/transfer/capsule-export.ts:462` — "// in includeKinds OR passed `includeTranscripts: true`. The override flag"
- `packages/remnic-core/src/transfer/capsule-export.ts:463` — "// avoids the footgun of having the CLI build a hard-coded kinds list that"
- `packages/remnic-core/src/transfer/capsule-export.ts:464` — "// inadvertently drops valid memory dirs like `peers/` or `forks/`. (Cursor / #747)"
- `packages/remnic-core/src/transfer/capsule-export.ts:187` — "// If the output directory lives inside the export root, scan results would"
- `packages/remnic-core/src/transfer/capsule-export.ts:188` — "// re-import previous capsule archives on subsequent runs. Compute the"
- `packages/remnic-core/src/transfer/capsule-export.ts:189` — "// posix-relative path of the outDir under rootAbs (or `null` when it sits"
- `packages/remnic-core/src/transfer/capsule-export.ts:190` — "// outside) so {@link shouldInclude} can skip the entire subtree."
- `packages/remnic-core/src/transfer/capsule-export.ts:449` — "// Exclude the output directory subtree. Without this, re-running against"
- `packages/remnic-core/src/transfer/capsule-export.ts:450` — "// the same root packages prior `.capsule.json.gz` archives and sidecar"
- `packages/remnic-core/src/transfer/capsule-export.ts:451` — "// manifests as records, causing bundle bloat and leaking stale exports."
- `packages/remnic-core/src/transfer/capsule-export.ts:452` — "// `outDir === root` is rejected at the entrypoint (`exportCapsule`), so"
- `packages/remnic-core/src/transfer/capsule-export.ts:453` — "// {@link computeOutDirRel} never returns `"."` for the in-tree case here."
- `packages/remnic-core/src/transfer/capsule-export.ts:174` — "// Reject outDir === root: the input scan would otherwise be entirely"
- `packages/remnic-core/src/transfer/capsule-export.ts:175` — "// skipped by `shouldInclude` (outDirRelPosix === ".") and the export would"
- `packages/remnic-core/src/transfer/capsule-export.ts:176` — "// silently succeed with an empty manifest/archive — a Rule 51 violation"
- `packages/remnic-core/src/transfer/capsule-export.ts:177` — "// and a data-loss footgun for callers that point outDir at the root."
- `packages/remnic-core/src/transfer/capsule-export.ts:293` — "/** * Strict ISO-8601 form accepted by {@link parseSince}. We accept exactly two * shapes: * * 1. Date-only: `YYYY-MM-DD"
- `packages/remnic-core/src/transfer/capsule-export.ts:326` — "// Reject calendar overflow: `Date.parse("2026-02-31")` returns a finite ms"
- `packages/remnic-core/src/transfer/capsule-export.ts:327` — "// for March 3 because the JS Date constructor silently normalizes invalid"
- `packages/remnic-core/src/transfer/capsule-export.ts:328` — "// calendar values. Round-trip through `Date` and compare the year/month/day"
- `packages/remnic-core/src/transfer/capsule-export.ts:329` — "// components against the input prefix to catch this. Rule 51: silent"
- `packages/remnic-core/src/transfer/capsule-export.ts:330` — "// coercion of an exact time boundary is a Rule 51 violation that breaks"
- `packages/remnic-core/src/transfer/capsule-export.ts:331` — "// incremental exports."
- `packages/remnic-core/src/transfer/capsule-export.ts:345` — "/** * Verify that parsing {@link since} did not silently normalize an invalid * calendar date (e.g. `2026-02-31` → `2026"
- `packages/remnic-core/src/transfer/capsule-export.ts:362` — "// For inputs with an explicit non-zero offset, compare against the"
- `packages/remnic-core/src/transfer/capsule-export.ts:363` — "// wall-clock components of that offset instead of UTC. Date.parse maps to"
- `packages/remnic-core/src/transfer/capsule-export.ts:364` — "// UTC, so 2026-02-31T00:00:00-05:00 and 2026-02-31T00:00:00Z both fail the"
- `packages/remnic-core/src/transfer/capsule-export.ts:365` — "// calendar check; the wall-clock comparison via `m[1..3]` is still the"
- `packages/remnic-core/src/transfer/capsule-export.ts:366` — "// right reference because the input's stated calendar day must exist."
- `packages/remnic-core/src/transfer/capsule-export.ts:389` — "// Empty array is treated as "include nothing" rather than "include all""
- `packages/remnic-core/src/transfer/capsule-export.ts:390` — "// so callers cannot accidentally widen the filter by passing []. This"
- `packages/remnic-core/src/transfer/capsule-export.ts:391` — "// mirrors PR-1/6 Rule 51: reject ambiguous input — but here we model it"
- `packages/remnic-core/src/transfer/capsule-export.ts:392` — "// as "explicit empty allow-list" rather than throwing, because empty"
- `packages/remnic-core/src/transfer/capsule-export.ts:393` — "// capsules ARE valid (see acceptance criteria)."
- `packages/remnic-core/src/transfer/capsule-export.ts:429` — "// Mirror gotcha #24: existsSync returns true for files. The export root"
- `packages/remnic-core/src/transfer/capsule-export.ts:430` — "// MUST be a directory or the walk silently succeeds with zero entries."
- `packages/remnic-core/src/transfer/capsule-export.ts:474` — "// includeKinds restricts to whitelisted top-level segments. Files at"
- `packages/remnic-core/src/transfer/capsule-export.ts:475` — "// the repo root (no top-level dir) are excluded under an explicit"
- `packages/remnic-core/src/transfer/capsule-export.ts:476` — "// allow-list because they are not categorized."
- `packages/remnic-core/src/transfer/capsule-export.ts:515` — "// `parent` (structured, PR 4/6) and `parentCapsule` (legacy string) carry"
- `packages/remnic-core/src/transfer/capsule-export.ts:516` — "// overlapping information. The schema documents the invariant: when"
- `packages/remnic-core/src/transfer/capsule-export.ts:517` — "// `parent` is non-null, `parentCapsule` SHOULD equal `parent.capsuleId`."
- `packages/remnic-core/src/transfer/capsule-export.ts:518` — "// We derive the legacy field from the structured field whenever the"
- `packages/remnic-core/src/transfer/capsule-export.ts:519` — "// caller supplies `parent` but omits `parentCapsule`, so a single-source"
- `packages/remnic-core/src/transfer/capsule-export.ts:520` — "// override path produces a manifest that satisfies the documented"
- `packages/remnic-core/src/transfer/capsule-export.ts:521` — "// invariant for legacy V2 readers (Cursor medium #751 round 3)."
- `packages/remnic-core/src/transfer/capsule-export.ts:522` — "// An explicit `parentCapsule` override still wins — including an explicit"
- `packages/remnic-core/src/transfer/capsule-export.ts:523` — "// `null` — so callers can intentionally diverge from the structured field"
- `packages/remnic-core/src/transfer/capsule-export.ts:524` — "// for migration scenarios."
- `packages/remnic-core/src/transfer/capsule-export.ts:549` — "// Re-parse to surface invalid overrides with the same zod errors a caller"
- `packages/remnic-core/src/transfer/capsule-export.ts:550` — "// would get when constructing a CapsuleBlock by hand."
- `packages/remnic-core/src/transfer/capsule-export.ts:239` — "// Sidecar manifest for cheap inspection without decompressing the archive."
- `packages/remnic-core/src/transfer/capsule-export.ts:242` — "// Single-artifact gzip archive containing the whole bundle. JSON encoded"
- `packages/remnic-core/src/transfer/capsule-export.ts:243` — "// before gzip so the archive is opaque to file-tree filtering. Using the"
- `packages/remnic-core/src/transfer/capsule-export.ts:244` — "// sync helper keeps the function pure async (no filesystem callback chain)"
- `packages/remnic-core/src/transfer/capsule-export.ts:245` — "// and matches the existing transfer modules' style."
- `packages/remnic-core/src/transfer/capsule-export.ts:250` — "// Optional encryption (PR 4/4). When opts.encrypt is true, wrap the"
- `packages/remnic-core/src/transfer/capsule-export.ts:251` — "// plaintext gzip in a REMNIC-ENC sealed envelope and remove the plaintext."
- `packages/remnic-core/src/transfer/capsule-export.ts:252` — "// Per gotcha #54: write the encrypted file before removing the plaintext so"
- `packages/remnic-core/src/transfer/capsule-export.ts:253` — "// a crash mid-encrypt does not destroy the only copy."
- `packages/remnic-core/src/transfer/capsule-export.ts:260` — "// Remove the plaintext only after the encrypted file was written successfully."
- `packages/remnic-core/src/transfer/capsule-import.ts:179` — "// Auto-detect encrypted archives. If the file ends with `.enc` or starts"
- `packages/remnic-core/src/transfer/capsule-import.ts:180` — "// with the REMNIC-ENC magic header, decrypt it first before gunzip+parse."
- `packages/remnic-core/src/transfer/capsule-import.ts:181` — "// Rule 48: default is "not encrypted"; we only attempt decryption when the"
- `packages/remnic-core/src/transfer/capsule-import.ts:182` — "// header is definitively present, never on ambiguous content."
- `packages/remnic-core/src/training-export/converter.ts:21` — "// ---------------------------------------------------------------------------"
- `packages/remnic-core/src/training-export/converter.ts:22` — "// Frontmatter parsing (mirrors storage.ts but kept standalone)"
- `packages/remnic-core/src/training-export/converter.ts:271` — "// Collect from every recall category directory (RECALL_FALLBACK_DIRS — the"
- `packages/remnic-core/src/training-export/converter.ts:272` — "// single source of truth), so newly-routed categories (decisions/,"
- `packages/remnic-core/src/training-export/converter.ts:273` — "// preferences/, ...) are exported, not just facts/ + corrections/ (#1546)."
- `packages/remnic-core/src/training-export/converter.ts:278` — "// entities/ is NOT a recall category — it stays a separate opt-in include."
- `packages/remnic-core/src/training-export/cli-date-validation.test.ts:245` — "// "2026-01-15T23:30:00" (no Z, no offset) parses as local time. The"
- `packages/remnic-core/src/training-export/cli-date-validation.test.ts:246` — "// overflow check must NOT compare against UTC components, which would"
- `packages/remnic-core/src/training-export/cli-date-validation.test.ts:247` — "// misreport an overflow in non-UTC host timezones."
- `packages/remnic-core/src/training-export/index.ts:22` — "// `parseStrictCliDate` is the only public surface; `isCalendarDateValid`"
- `packages/remnic-core/src/training-export/index.ts:23` — "// is an internal helper (not re-exported). Exposing it as a public API"
- `packages/remnic-core/src/training-export/index.ts:24` — "// would commit to maintaining it indefinitely for no external caller"
- `packages/remnic-core/src/training-export/index.ts:25` — "// (Cursor review follow-up to PR #509)."
