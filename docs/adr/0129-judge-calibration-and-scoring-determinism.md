# Judge calibration and bench scoring are deterministic and content-free, persisted atomically, with judge identities verifiable on load

Status: accepted

## Context
Cross-tier judge calibration (issue #1573 PR3) trusts local-judge numbers only insofar as a kappa computed against a fixed slice says so, and several bench scoring surfaces had order-, locale-, or filename-dependent bugs that silently skewed results (a filter-drop filename sanitizer mapped "foo.bar" and "foobar" to the same file, letting one benchmark overwrite another's kappa).

This ADR merges the sweep themes: judge-calibration-protocol, calibration-state-persistence, benchmark-id-filename-separator, sealed-rubric-payload-sealing, ingestion-scorer-determinism, demo-correction-parser-scope, lower-is-better-direction.

Merged sweep themes: judge-calibration-protocol, calibration-state-persistence, benchmark-id-filename-separator, sealed-rubric-payload-sealing, ingestion-scorer-determinism, demo-correction-parser-scope, lower-is-better-direction.

## Decision
- The calibration slice is selected deterministically and content-free from the universe of question ids, at a fixed size per benchmark (raised to 200 by issue #1877 to reduce slice sensitivity). A stored result qualifies as a calibration source only above a minimum completed-task count.
- Stored results are deduped by questionId — first answer per id wins — otherwise duplicate taskIds double-count a question, inflating sampleSize and skewing kappa. Slice order is preserved so verdicts line up with the slice's question ids.
- Calibration state is persisted atomically (bytes land on a temp file, then rename into place; best-effort temp cleanup) and records the judge identities alongside the kappa. On load, identities are optional (older state files predate them), but if ANY identity field is present, ALL four must be present and string-typed — otherwise the binding is unreliable and identities are dropped; the calibration subset still loads and the attach path treats unbound state as "attach anyway" for backwards compatibility.
- Benchmark ids are sanitized for calibration-state filenames character-by-character (no polynomial regex on uncontrolled input): only `[a-z0-9._-]` survives, each disallowed character becomes a single `-` separator so distinct ids stay distinct, consecutive separators collapse, edges are trimmed.
- Sealed-rubric judge payloads are built per task with the rubric prompt kept on the system side of the conversation.
- The ingestion scorer normalizes before comparing: NFKC decomposition first (composed/decomposed forms — accented letters, full-width characters, ligatures — compare equal), then lowercase, then punctuation/symbol stripping via Unicode property escapes, which preserves Unicode letters and digits so multilingual names are not collapsed. Exact-name matches run first (pass 1) to avoid alias-order sensitivity.
- The demo memory-correction parser accepts only the deterministic correction forms emitted by the synthetic corpus, plus the adapter conformance those forms imply.
- Comparison stats: for lower-is-better metrics, a positive percent change is a regression.

## Consequences
Older calibration files load with unbound identities. Changing the slice size or selection re-baselines every stored kappa. The filename sanitizer maps some distinct id families onto the same safe charset — the separator rule is the documented contract, not a bijection.

## Origin comments
- `packages/bench/src/demo/mcp-memory-correction.ts:6` — "/** * Parse only the deterministic correction forms emitted by the synthetic * MemCorrect corpus, plus the adapter confo"
- `packages/bench/src/ingestion-scorer.ts:15` — "// NFKC decomposition first so that composed/decomposed forms (e.g. accented"
- `packages/bench/src/ingestion-scorer.ts:16` — "// letters, full-width characters, ligatures) compare equal. Then lowercase,"
- `packages/bench/src/ingestion-scorer.ts:17` — "// strip punctuation/symbols via Unicode property escapes (preserves all"
- `packages/bench/src/ingestion-scorer.ts:18` — "// Unicode letters and digits, so multilingual names are not collapsed)."
- `packages/bench/src/ingestion-scorer.ts:52` — "// Pass 1: exact-name matches first to avoid alias-order sensitivity."
- `packages/bench/src/judges/calibration-slice.test.ts:693` — "// \"foo.bar\" and \"foobar\" must NOT collide — the old filter-drop mapped"
- `packages/bench/src/judges/calibration-slice.test.ts:694` — "// both to \"foobar.json\", letting one benchmark overwrite another's kappa."
- `packages/bench/src/judges/calibration-slice.test.ts:695` — "// With the fix, punctuation becomes a separator: \"foo-bar\" vs \"foobar\"."
- `packages/bench/src/judges/calibration-slice.ts:1` — "/** * Cross-tier judge calibration — issue #1573 PR3. * * The two-tier protocol (#1573) trusts local-judge numbers for r"
- `packages/bench/src/judges/calibration-slice.ts:43` — "/** * Judge identities recorded alongside a persisted calibration so a later run * can verify the kappa was computed for"
- `packages/bench/src/judges/calibration-slice.ts:57` — "/** * The full persisted calibration record as loaded from disk: the artifact * subset plus the (optional) judge identit"
- `packages/bench/src/judges/calibration-slice.ts:79` — "/** * Fixed slice size per benchmark. Issue #1877 raises the calibration target * from 50 to 200 to reduce slice sensiti"
- `packages/bench/src/judges/calibration-slice.ts:86` — "/** * Minimum number of completed tasks a stored result must have to be a valid * calibration source (codex P2 review). "
- `packages/bench/src/judges/calibration-slice.ts:200` — "/** * Select the calibration slice from a universe of question ids. * * The selection is deterministic and content-free:"
- `packages/bench/src/judges/calibration-slice.ts:255` — "// Dedupe by questionId (cursor review: a stored result with duplicate"
- `packages/bench/src/judges/calibration-slice.ts:256` — "// taskIds would otherwise double-count the same question, inflating"
- `packages/bench/src/judges/calibration-slice.ts:257` — "// sampleSize and skewing kappa). First answer per id wins; slice order"
- `packages/bench/src/judges/calibration-slice.ts:258` — "// is preserved so verdicts line up with sliceQuestionIds."
- `packages/bench/src/judges/calibration-slice.ts:554` — "/** * Persist a calibration result so subsequent local artifacts can carry the * kappa (issue #1573 done-when: \"a kappa "
- `packages/bench/src/judges/calibration-slice.ts:596` — "// Atomic write: land bytes on a temp file, then rename into place. The"
- `packages/bench/src/judges/calibration-slice.ts:597` — "// rename is atomic on POSIX; best-effort temp cleanup on failure."
- `packages/bench/src/judges/calibration-slice.ts:610` — "/** * Load a previously persisted calibration result for a benchmark. Returns * `undefined` when no calibration has been"
- `packages/bench/src/judges/calibration-slice.ts:694` — "// Identities are optional (older state files predate them). If ANY identity"
- `packages/bench/src/judges/calibration-slice.ts:695` — "// field is present, ALL four must be present and string — otherwise the"
- `packages/bench/src/judges/calibration-slice.ts:696` — "// binding is unreliable and identities are dropped (the calibration subset"
- `packages/bench/src/judges/calibration-slice.ts:697` — "// still loads; the attach path treats unbound state as \"attach anyway\" for"
- `packages/bench/src/judges/calibration-slice.ts:698` — "// backwards compatibility)."
- `packages/bench/src/judges/calibration-slice.ts:717` — "/** * Sanitize a benchmark id for use as a calibration-state filename. Only * `[a-z0-9._-]` survives (mirrors the artifa"
- `packages/bench/src/judges/calibration-slice.ts:724` — "// Character-by-character sanitization (CodeQL: avoids polynomial regex on"
- `packages/bench/src/judges/calibration-slice.ts:725` — "// uncontrolled input). Disallowed characters become a single \"-\" separator"
- `packages/bench/src/judges/calibration-slice.ts:726` — "// so distinct benchmark ids stay distinct (cursor review: the old filter-drop"
- `packages/bench/src/judges/calibration-slice.ts:727` — "// mapped \"foo.bar\" and \"foobar\" to the same file). Consecutive separators"
- `packages/bench/src/judges/calibration-slice.ts:728` — "// are collapsed and edges are trimmed."
- `packages/bench/src/judges/cohen-kappa.ts:1` — "/** * Cohen's kappa — inter-rater agreement for the cross-tier judge calibration * (issue #1573 PR3). * * The local-lab "
- `packages/bench/src/judges/sealed-rubric.ts:119` — "/** * Build the judge message payload for a single task. Keeps the rubric prompt * on the system side of the conversat"
- `packages/bench/src/run-seeds.ts:1` — "/** * Seed-sequence generation for benchmark runs. * * Factored out of `benchmark.ts` so individual runners ca"
- `packages/bench/src/stats/comparison.ts:58` — "// For lower-is-better metrics, a positive percent change is a regression."
