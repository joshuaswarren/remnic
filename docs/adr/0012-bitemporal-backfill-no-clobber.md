# Temporal backfill patches only missing or stale batch-anchored bounds, gated on extracted start bounds and the fact category

Status: accepted

## Context
Re-extraction of a duplicate fact must correct bi-temporal bounds on existing copies (#1671, #1670, #1578) without clobbering good data or paying a scan on every dedup hit. Copies carry per-fact extracted anchors or batch/legacy assumed anchors; promotion duplicates exist across namespaces; and naive provenance heuristics proved fragile in review. Calibration applies the same shape of problem weekly: a retried reinforcement week must not double-apply.

## Decision
Backfill is a no-clobber, gate-guarded patch: (1) invalid_at/observedAt are patched only when MISSING — never overwritten; (2) valid_at is patched only when the incoming validFrom is EXTRACTED and the copy's start bound is batch-anchored (assumed/legacy); the mechanism is an equality short-circuit (fm.valid_at !== bounds.validFrom skips the write), not a provenance heuristic — a differing extracted validFrom overwrites the stale start regardless of the copy's eventTimeSource, and end-only extractions (eventTimeSource=extracted, valid_at still assumed) are still correctable by a later start-bound extraction; deterministic re-resolution means stable content re-resolves to the same value, so the equality no-op is the only no-clobber needed; (3) the I/O gate fires only on an EXTRACTED start bound — an assumed validFrom (which resolveFactEventTime sets for every fact) never triggers the readAllMemories scan, so ordinary duplicate facts pay nothing; (4) the scan is gated on writeCategory === "fact": a non-fact duplicate (preference/decision/procedure) is never matched or patched even on a content-hash collision; (5) when the source-namespace dedup short-circuit fires, the promotion-cascade patches promotion-target copies (profile + shared namespaces) independently, so cross-namespace recall cannot surface an expired fact; (6) the bi-temporal frontmatter round-trip through the writeMemoryFrontmatter chokepoint must preserve every pre-existing field alongside the new fields — no field dropped or duplicated; the validity filter is status-orthogonal: isValidityExpiredNow reads only invalid_at, so an active memory can be validity-expired and status never enters the decision. MERGED THEME (per the ten-file limit): weekly rule calibration uses the same idempotency discipline — applied-week stamps live in an applied-week list (legacy single stamp folded in on read) attached to the index written with the reinforced rules, so a retry of any already-applied week (including an out-of-order older-week retry after a newer week applied) is recognized and never increments evidence counts; correction-reader internals are exported for regression coverage, prompts are size-limited, and consolidation is callable standalone of weekly compounding.

## Consequences
Extracted bounds that are wrong can only be corrected by another extraction, never by manual backfill of assumed data. The I/O gate means a fact whose only event-time signal is an end bound does not trigger correction scans. Equality-based no-clobber depends on deterministic extraction (#1670): any nondeterminism in bound resolution turns the short-circuit into silent staleness. Out-of-order calibration retries are idempotent but cannot merge evidence across retried weeks.

## Origin comments
### temporal-backfill-dedup
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:9` — "/** * Issue #1671 — backfill invalid_at/observedAt onto deduped promotion copies. * * When a fact is re-extracted and no"

### temporal-backfill-no-clobber
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:107` — "// Attempt to backfill a DIFFERENT invalid_at — the patch should only fill"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:108` — "// MISSING fields, not overwrite. (The orchestrator helper checks before"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:109` — "// patching; here we prove the helper's gate logic is correct by simulating"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:110` — "// the same condition: only patch if the field is absent/empty.)"

### valid-at-propagation-rule
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:173` — "// Thread 2 — valid_at propagation. A re-extracted duplicate whose event time"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:174` — "// yields only a start bound ("since 2024", "yesterday") must get the corrected"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:175` — "// per-fact validFrom onto the existing copy so as-of recall uses the corrected"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:176` — "// start. The orchestrator helper's rule: patch valid_at when the incoming"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:177` — "// validFrom is EXTRACTED and the copy's start bound is batch-anchored"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:178` — "// (assumed/legacy); never clobber a copy that already carries an extracted"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:179` — "// per-fact anchor. This test pins that rule against the storage patch the"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:180` — "// helper issues."

### valid-at-equality-short-circuit
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:237` — "// Re-extraction resolves the SAME start bound (deterministic per #1670)."
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:238` — "// The helper's equality short-circuit (fm.valid_at !== bounds.validFrom)"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:239` — "// skips the redundant write — the only no-clobber that holds without a"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:240` — "// fragile provenance heuristic (review codex PRRT_Ov7LKC)."
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:266` — "// Re-extraction resolves a DIFFERING extracted start bound. Exact-content"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:267` — "// dedup + #1670 determinism means stable content re-resolves to the same"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:268` — "// value (equality no-op above); a divergence means the copy's start is"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:269` — "// stale (batch/assumed) and the extracted validFrom is authoritative."
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:289` — "// Review (codex PRRT_Ov68oA + PRRT_Ov7LKC): an END-only extraction ("through"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:290` — "// 2026") sets eventTimeSource = "extracted" (end resolved) but leaves valid_at"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:291` — "// batch/assumed-anchored. A later START-bound extraction must still correct"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:292` — "// valid_at. The helper now uses an equality short-circuit (no fragile"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:293` — "// provenance heuristic): the differing extracted validFrom overwrites the"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:294` — "// stale start regardless of the copy's eventTimeSource."

### temporal-backfill-io-gate
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:334` — "// Gate guard (review cursor PRRT_OvHk / codex PRRT_OvHxVH): resolveFactEventTime"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:335` — "// sets a validFrom for EVERY fact (assumed = ingestion anchor). The helper's"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:336` — "// I/O gate must NOT scan on an assumed validFrom — only an EXTRACTED start bound"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:337` — "// changes recall. This pins the gate decision so ordinary duplicate facts"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:338` — "// without an extracted event time do not pay a readAllMemories scan on every"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:339` — "// dedup hit."

### promoted-cascade-backfill
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:368` — "// Thread 1 — promoted-cascade backfill. When the source-namespace dedup"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:369` — "// short-circuit fires, the helper must also patch promotion-target copies"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:370` — "// (profile + shared namespaces) so cross-namespace recall does not surface an"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:371` — "// expired fact. This proves the mechanism the orchestrator's promotion-cascade"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:372` — "// closure relies on: backfilling two separate storages patches each"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:373` — "// independently."

### backfill-non-fact-guard
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:426` — "// Thread 3 — non-fact guard. The source dedup backfill call site is gated on"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:427` — "// writeCategory === "fact", so a non-fact duplicate (preference/decision/"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:428` — "// procedure) never reaches the fact-only backfill scan. This proves the"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:429` — "// helper's category guard that makes that call-site gate correct: a non-fact"
- `packages/remnic-core/src/bitemporal-dedup-backfill.test.ts:430` — "// copy is never matched/patched even if its content hash collides."

### bitemporal-frontmatter-contract
- `packages/remnic-core/src/bitemporal-frontmatter.test.ts:10` — "/** * Issue #1578 PR 1 — bi-temporal validity frontmatter round-trip + injection * filter unit tests. * * These tests pi"
- `packages/remnic-core/src/bitemporal-frontmatter.test.ts:78` — "// Exercises the full serialize→parse round trip through the"
- `packages/remnic-core/src/bitemporal-frontmatter.test.ts:79` — "// writeMemoryFrontmatter chokepoint for the fields writeMemory does not"
- `packages/remnic-core/src/bitemporal-frontmatter.test.ts:80` — "// accept as options (invalid_at, forgottenAt). This is the direct"
- `packages/remnic-core/src/bitemporal-frontmatter.test.ts:81` — "// regression guard for the "frontmatter parser corruption" risk: every"
- `packages/remnic-core/src/bitemporal-frontmatter.test.ts:82` — "// pre-existing field must survive alongside the new bi-temporal fields,"
- `packages/remnic-core/src/bitemporal-frontmatter.test.ts:83` — "// with no field dropped or duplicated."

### validity-filter-status-orthogonal
- `packages/remnic-core/src/bitemporal-frontmatter.test.ts:188` — "// The filter must be status-orthogonal (issue pitfall matrix): an `active`"
- `packages/remnic-core/src/bitemporal-frontmatter.test.ts:189` — "// memory can be validity-expired. isValidityExpiredNow only receives the"
- `packages/remnic-core/src/bitemporal-frontmatter.test.ts:190` — "// invalid_at field, so status never enters the decision."

### calibration-applied-week-idempotency
- `packages/remnic-core/src/calibration.test.ts:138` — "// A later week keeps the earlier stamp: an out-of-order retry of week A"
- `packages/remnic-core/src/calibration.test.ts:139` — "// after week B must still be recognized as already applied."
- `packages/remnic-core/src/calibration.test.ts:170` — "// A retry of an older week stays recognized after a newer week applied:"
- `packages/remnic-core/src/calibration.test.ts:171` — "// the reader folds the legacy single stamp into the applied-week list."
- `packages/remnic-core/src/calibration.ts:48` — "/** * Weeks whose rule reinforcement is already committed. A retry of any of * these weeks must not increment `evidenceC"
- `packages/remnic-core/src/calibration.ts:104` — "/** * Attach the week stamp to the index that will be written with the reinforced * rules. The stamp and the evidence in"
- `packages/remnic-core/src/calibration.ts:493` — "/** * When set, a week whose reinforcement is already in the index is returned * as-is. Weekly synthesis passes the ISO "

### calibration-correction-reader-export
- `packages/remnic-core/src/calibration.ts:170` — "/** * Exported for entity-contamination R-11 regression coverage (#682 * PR 2/3 — codex review). Tests can drive the rea"

### calibration-prompt-size-limit
- `packages/remnic-core/src/calibration.ts:341` — "// limit to avoid huge prompts"

### calibration-recall-rule-selection
- `packages/remnic-core/src/calibration.ts:430` — "// Simple relevance: include all rules (they're already filtered to this user)"

### calibration-standalone-consolidation-entry
- `packages/remnic-core/src/calibration.ts:561` — "/** * Standalone entry point for calibration consolidation that can be called * independently of weekly compounding. The"
