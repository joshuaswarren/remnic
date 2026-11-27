# Weekly synthesis is single-flight, atomic, idempotent, and never reports blocked writes as successes

Status: accepted

## Context
The daemon scheduler and access surfaces could run weekly synthesis concurrently; crashes mid-run, retries, tombstones, and forgotten memories could double-count evidence, reinforce the same rules twice, or copy forgotten content back into recall.

## Decision
- Weekly synthesis is single-flight per memory directory — the daemon scheduler and the access surface share one boundary. The week-done marker is written atomically: a partially written marker never satisfies the skip check. The markdown report is the completion marker, written AFTER the JSON, rubrics, and mistakes artifacts, so a crash before it retries the whole week.
- Calibration consolidation (PEDC) is keyed by week id so a retry does not reinforce the same rules; only a completed week consolidates — a manual in-progress-week run must not double-count partial evidence. The Codex materialize post-hook (#378) runs inside its own try/catch: a failed materialize never aborts weekly synthesis, and the helper silently no-ops when the feature flag or per-trigger toggle is off, the sentinel is missing, or nothing changed since the previous run.
- Promotion and evidence: a tombstone-blocked promotion (#1645) lands as pending_review (no active copy) and is diverted to the tombstoneBlocked list — the report never claims a blocked write as a successfully promoted active memory. Machine-synthesized data uses sealed-envelope strict compose (#1989). Evidence gathering rejects a symlinked namespaces directory outright rather than following it out of the store; `ns-default` is the empty identity — the migrated default store, not a foreign namespace; out-of-week timestamped names are skipped BEFORE lstat/realpath so a large corrections directory stays in the weekly budget; corrections with any explicit non-active status (including forgotten) stay out of compounding so a forget is never copied back into recall or promotion (missing status means the writer default `active`). Rubric scoring is conservative: reward applied, penalize skipped/failed. Text boundary stripping (trailing punctuation) is a linear walk — no anchored regex that backtracks polynomially (CodeQL ReDoS). Preference consolidation emits expanded, query-aware "would prefer" reformulations matching the LongMemEval expected format.

## Consequences
- Conservative evidence filtering under-includes by design: forgotten/archived corrections never inform synthesis. Strict compose makes malformed machine output a hard failure rather than a repairable draft.

## Origin comments
- `packages/remnic-core/src/compounding/engine.ts:332` — "// Linear trailing-punctuation strip (no `/[,:;]+$/` — CodeQL flags that as a"
- `packages/remnic-core/src/compounding/engine.ts:333` — "// polynomial-backtracking ReDoS on long runs of ',;:'). Walk back once, O(n)."
- `packages/remnic-core/src/compounding/engine.ts:534` — "// #378: fire the Codex materialize post-hook so"
- `packages/remnic-core/src/compounding/engine.ts:535` — "// `codexMaterializeOnConsolidation` actually has a runtime effect"
- `packages/remnic-core/src/compounding/engine.ts:536` — "// when the causal consolidation path runs. The helper silently no-ops"
- `packages/remnic-core/src/compounding/engine.ts:537` — "// when the feature flag or the per-trigger toggle is off, when the"
- `packages/remnic-core/src/compounding/engine.ts:538` — "// sentinel is missing, or when nothing has changed since the previous"
- `packages/remnic-core/src/compounding/engine.ts:539` — "// run. Wrapped in its own try/catch so a failed materialize never"
- `packages/remnic-core/src/compounding/engine.ts:540` — "// aborts weekly synthesis."
- `packages/remnic-core/src/compounding/engine.ts:557` — "// PEDC: calibration consolidation, keyed by the week id so a retry does"
- `packages/remnic-core/src/compounding/engine.ts:558` — "// not reinforce the same rules. Only a completed week consolidates: a"
- `packages/remnic-core/src/compounding/engine.ts:559` — "// manual in-progress-week run must not double-count partial evidence."
- `packages/remnic-core/src/compounding/engine.ts:576` — "// The markdown report is the completion marker, so it is written after the"
- `packages/remnic-core/src/compounding/engine.ts:577` — "// JSON, rubrics, and mistakes artifacts. A crash before that write retries."
- `packages/remnic-core/src/compounding/engine.ts:726` — "// Sealed-envelope write (issue #1989 PR4): synthesized machine data."
- `packages/remnic-core/src/compounding/engine.ts:732` — "// #1645: a tombstone-blocked promotion lands pending_review (no active"
- `packages/remnic-core/src/compounding/engine.ts:733` — "// copy) — divert it to the tombstoneBlocked list so the report never"
- `packages/remnic-core/src/compounding/engine.ts:734` — "// claims a blocked write as a successfully promoted active memory."
- `packages/remnic-core/src/compounding/engine.ts:1003` — "// Conservative weighting: reward applied, penalize skipped/failed."
- `packages/remnic-core/src/compounding/preference-consolidator.ts:1` — "preference-consolidator.ts — IRC Preference Consolidation for Engram Post-extraction pass that synthesizes preference..."
- `packages/remnic-core/src/compounding/preference-consolidator.ts:596` — "Generate expanded, query-aware preference reformulations. This is the key to matching benchmark expected answers whic..."
- `packages/remnic-core/src/compounding/preference-consolidator.ts:617` — "// "would prefer" reformulation — matches LongMemEval expected format"
- `packages/remnic-core/src/compounding/weekly-evidence.ts:314` — "// A symlinked namespaces directory can point outside the store. Reject the"
- `packages/remnic-core/src/compounding/weekly-evidence.ts:315` — "// whole tree rather than following it."
- `packages/remnic-core/src/compounding/weekly-evidence.ts:348` — "// `ns-default` is the empty identity. It is the migrated default store,"
- `packages/remnic-core/src/compounding/weekly-evidence.ts:349` — "// not a foreign namespace."
- `packages/remnic-core/src/compounding/weekly-evidence.ts:393` — "// A timestamped name outside this week is historical. Skip it before"
- `packages/remnic-core/src/compounding/weekly-evidence.ts:394` — "// lstat or realpath so a large corrections directory stays inside the"
- `packages/remnic-core/src/compounding/weekly-evidence.ts:395` — "// weekly budget."
- `packages/remnic-core/src/compounding/weekly-evidence.ts:479` — "// Missing status is the writer default (`active`). Any other explicit"
- `packages/remnic-core/src/compounding/weekly-evidence.ts:480` — "// status, including forgotten, stays out of compounding so a forget is"
- `packages/remnic-core/src/compounding/weekly-evidence.ts:481` — "// not copied back into recall or promotion."
- `packages/remnic-core/src/compounding/weekly-scheduler.ts:102` — "// Atomic: a partially written marker must never satisfy the skip check."
- `packages/remnic-core/src/compounding/weekly-synthesis-queue.ts:1` — "Single-flight boundary for weekly synthesis, keyed by memory directory. The daemon scheduler and the access surface e..."
