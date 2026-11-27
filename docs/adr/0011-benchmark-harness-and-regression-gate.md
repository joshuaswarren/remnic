# Benchmark performance claims come from the coding-graph harness, and the regression gate validates every load-bearing field before it skips or compares

Status: accepted

## Context
The bench coding-graph harness (issue #1557) produces the metric reports that perf claims and the tracked-baseline regression gate (issue #1557 step 3) depend on, so both measurement methodology and gate validation had to be made robust to hostile conditions: shared CI runners swing cold-start timings >50%, JSON-loaded reports bypass TypeScript's nominal types, and a corrupt or partial report previously crashed the gate or silently passed (cursor #1688 review: "v2 report crashes gate"; "Validate corrupt reports before machine skips").

This ADR merges the sweep themes: harness-authority-for-perf-claims, bench-optional-loading-boundary, run-seeds-circular-import, benchmark-measurement-methodology, modified-loop-full-fixture-restore, regression-gate-guard-ordering, machine-fingerprint-skip-semantics, regression-gate-design.

Merged sweep themes: harness-authority-for-perf-claims, bench-optional-loading-boundary, run-seeds-circular-import, benchmark-measurement-methodology, modified-loop-full-fixture-restore, regression-gate-guard-ordering, machine-fingerprint-skip-semantics, regression-gate-design.

## Decision
**Measurement (harness):**
- All performance claims for the coding-graph surface come from the harness; consumers reach the suite only through its public re-export module, and seed-sequence generation lives in its own module factored out of the benchmark runner so runners share it without a circular import.
- Peak RSS is sampled across the entire run — a single end-of-run sample misses the index/traverse/dead-code peaks.
- Full-index timing takes the median of multiple fresh-DB samples; the first sample absorbs JIT/SQLite cold start and is discarded. Every sample uses a fresh DB because re-indexing is idempotent on an already-indexed store and would measure a no-op.
- DB size includes WAL sidecars: the store opens in WAL mode and uncheckpointed committed writes live in the `-wal` file; measuring only the main file underreports.
- The change-heavy churn measurement re-ingests a modified variant (fresh qualified name, bumped content hash, cross-file edges re-pointed at symbols that survive the prune) so the timed upsert measures edge deletion/creation plus re-resolution, not just pruning. Churn runs AFTER the steady-state DB-size measurement — churn upserts move pages to the free-list without shrinking the file, so earlier churn would inflate dbBytesPerKloc with residue. Afterwards the FULL fixture is restored (the store's FK ON DELETE CASCADE drops peer files' incoming edges when a file's nodes are pruned; restoring only the churned file would let later samples time a progressively smaller graph), the restore result is inspected so failure throws, and the restore is not timed.
- The machine fingerprint is captured once per run so baselines are comparable.

**Validation (regression gate):** guard order is fixed and each stage runs before any later skip or comparison:
1. Schema-version compatibility: a pre-v2 report lacks fields the metric extractor unconditionally dereferences; a schema mismatch fails with an actionable message instead of crashing or skipping.
2. Report field-presence + finite-number validation: every metric the extractor reads must be present and a finite number — top-level scalars (fullIndexMs.ms, fullIndexLocsPerSecond, deadCodeMs.ms, dbBytesPerKloc) AND nested percentile fields, both p50 and p95. NaN feeds ratio math and silently passes the gate.
3. Baseline-side validation: every PRESENT baseline metric must be a finite number; a merely absent metric stays additive (the "keys present in BOTH" contract) — only a present non-number is corruption.
4. Machine-fingerprint validation: a null fingerprint, or a fingerprint with missing/wrong-typed fields (nodeVersion feeds a string replace; cpuModel must be string-or-null), is rejected before comparison.
5. Fixture-config equality on EVERY key present in the baseline config, so new knobs are covered automatically — a different seed or language produces a structurally different repo and timing deltas across it are meaningless.
6. Machine-fingerprint skip: only after validation may a fingerprint difference SKIP the comparison (passed: true + skipped: true) with the mismatch surfaced for a human decision. cpuModel is nullable — null means "unknown", not "different"; a cpuModel difference counts only when both sides report a concrete model, so undetected CPU models do not spuriously skip a real regression on the same machine class.

## Consequences
Corrupt artifacts fail loudly instead of passing through cross-machine CI; the guard list must be extended whenever the extractor reads a new field. Cross-machine runs skip rather than fail, so gate automation must treat skipped as "human decision pending". Measurement costs extra harness runtime (multiple fresh indexes plus untimed restores) and DB-size numbers include WAL overhead.

## Origin comments
- `packages/bench/src/coding-graph/harness.test.ts:960` — "// guard, extractMetrics dereferenced the missing field and threw an"
- `packages/bench/src/coding-graph/harness.test.ts:961` — "// uncaught TypeError (cursor #1688 review: 'v2 report crashes gate')."
- `packages/bench/src/coding-graph/harness.test.ts:975` — "// Before the field-presence-before-machine-fingerprint reorder, a corrupt"
- `packages/bench/src/coding-graph/harness.test.ts:976` — "// v2 report (schema matches but incrementalModifiedUpdate is absent) on a"
- `packages/bench/src/coding-graph/harness.test.ts:977` — "// different machine would hit the machine-fingerprint skip FIRST and"
- `packages/bench/src/coding-graph/harness.test.ts:978` — "// return {passed:true, skipped:true} — silently passing a malformed"
- `packages/bench/src/coding-graph/harness.test.ts:979` — "// artifact through cross-machine CI. The field-presence guard must run"
- `packages/bench/src/coding-graph/harness.test.ts:980` — "// before the machine skip so corrupt reports always fail"
- `packages/bench/src/coding-graph/harness.test.ts:981` — "// (chatgpt-codex-connector #1688 review: 'Validate corrupt reports"
- `packages/bench/src/coding-graph/harness.test.ts:982` — "// before machine skips')."
- `packages/bench/src/coding-graph/harness.test.ts:995` — "// schemaVersion matches (both 2) and the top-level field exists, but a"
- `packages/bench/src/coding-graph/harness.test.ts:996` — "// nested sub-field is missing (e.g. incrementalModifiedUpdate: { p50: 1 }"
- `packages/bench/src/coding-graph/harness.test.ts:997` — "// with no p95). Before the deepened guard, extractMetrics produced"
- `packages/bench/src/coding-graph/harness.test.ts:998` — "// undefined for the missing p95 and the comparison loop silently skipped"
- `packages/bench/src/coding-graph/harness.test.ts:999` — "// it — letting corrupt artifacts pass as passed:true."
- `packages/bench/src/coding-graph/harness.test.ts:1000` — "// (chatgpt-codex-connector #1688 P2: 'Validate nested metric fields'.)"
- `packages/bench/src/coding-graph/harness.test.ts:1013` — "// The deepened guard must check BOTH p50 and p95, not just p95."
- `packages/bench/src/coding-graph/harness.test.ts:1014` — "// extractMetrics reads both percentiles; a report with p95 present"
- `packages/bench/src/coding-graph/harness.test.ts:1015` — "// but p50 missing previously passed the guard and the comparison loop"
- `packages/bench/src/coding-graph/harness.test.ts:1016` — "// silently skipped the undefined p50 metric (cursor Bugbot: 'Regression"
- `packages/bench/src/coding-graph/harness.test.ts:1017` — "// gate skips missing p50')."
- `packages/bench/src/coding-graph/harness.test.ts:1030` — "// The field-presence guard must also validate scalar/complex metrics"
- `packages/bench/src/coding-graph/harness.test.ts:1031` — "// (fullIndexMs.ms, fullIndexLocsPerSecond, deadCodeMs.ms, dbBytesPerKloc),"
- `packages/bench/src/coding-graph/harness.test.ts:1032` — "// not just nested micro-metrics. A report missing these on a different"
- `packages/bench/src/coding-graph/harness.test.ts:1033` — "// machine would otherwise fall through to the skip as hardware variance"
- `packages/bench/src/coding-graph/harness.test.ts:1034` — "// (chatgpt-codex-connector #1688 P2: \"Validate scalar report metrics\")."
- `packages/bench/src/coding-graph/harness.test.ts:1048` — "// A JSON-loaded report may carry a string where a number is expected"
- `packages/bench/src/coding-graph/harness.test.ts:1049` — "// (fullIndexLocsPerSecond: \"oops\"). Without Number.isFinite validation,"
- `packages/bench/src/coding-graph/harness.test.ts:1050` — "// the NaN ratio passes the tolerance check and the gate returns true."
- `packages/bench/src/coding-graph/harness.test.ts:1051` — "// (chatgpt-codex-connector #1688 P2: \"Validate metric values as finite\")."
- `packages/bench/src/coding-graph/harness.test.ts:1064` — "// A corrupt JSON report may have machine: null. Without the guard,"
- `packages/bench/src/coding-graph/harness.test.ts:1065` — "// compareMachineFingerprints dereferences the null and crashes."
- `packages/bench/src/coding-graph/harness.test.ts:1066` — "// (chatgpt-codex-connector #1688 P2: \"Validate machine fingerprints\")."
- `packages/bench/src/coding-graph/harness.ts:1` — "/** * Coding-graph benchmark harness (issue #1557). * * Runs the full metric set against a synthetic fixture and produce"
- `packages/bench/src/coding-graph/harness.ts:55` — "// Machine fingerprint — captured once per run so baselines are comparable."
- `packages/bench/src/coding-graph/harness.ts:161` — "// Track peak RSS across the entire run — a single end-of-run sample"
- `packages/bench/src/coding-graph/harness.ts:162` — "// misses the peak from index/traverse/dead-code operations."
- `packages/bench/src/coding-graph/harness.ts:176` — "// A single cold shot of a small index is dominated by JIT/SQLite"
- `packages/bench/src/coding-graph/harness.ts:177` — "// warm-up and swings >50% on shared CI runners, false-positiving the"
- `packages/bench/src/coding-graph/harness.ts:178` — "// regression gate (#1557). upsertFileBatch is idempotent on an"
- `packages/bench/src/coding-graph/harness.ts:179` — "// already-indexed store, so warmed samples need fresh DBs. Sample"
- `packages/bench/src/coding-graph/harness.ts:180` — "// FULL_INDEX_SAMPLES runs — the first absorbs cold-start overhead —"
- `packages/bench/src/coding-graph/harness.ts:181` — "// and take the median so the metric reflects steady-state cost."
- `packages/bench/src/coding-graph/harness.ts:273` — "// Include WAL files in DB-size measurement — GraphStore opens in WAL"
- `packages/bench/src/coding-graph/harness.ts:274` — "// mode, so the -wal file holds committed writes that haven't"
- `packages/bench/src/coding-graph/harness.ts:275` — "// checkpointed yet. Measuring only the main DB file underreports."
- `packages/bench/src/coding-graph/harness.ts:286` — "// Complementary to metric 3 (idempotent no-op): measures the"
- `packages/bench/src/coding-graph/harness.ts:287` — "// change-heavy path — edge deletion/creation + symbol re-resolution —"
- `packages/bench/src/coding-graph/harness.ts:288` — "// by re-ingesting a file whose symbol set has changed, then restoring"
- `packages/bench/src/coding-graph/harness.ts:289` — "// the original so the graph returns to baseline (#1688 item 1). Runs"
- `packages/bench/src/coding-graph/harness.ts:290` — "// AFTER the steady-state DB-size measurement: each churn upsert moves"
- `packages/bench/src/coding-graph/harness.ts:291` — "// pages to the SQLite free-list without shrinking the file, so a"
- `packages/bench/src/coding-graph/harness.ts:292` — "// pre-DB-size churn would inflate dbBytesPerKloc with churn residue"
- `packages/bench/src/coding-graph/harness.ts:293` — "// rather than reflecting the indexed fixture's steady-state footprint."
- `packages/bench/src/coding-graph/harness.ts:299` — "// Modified variant: a single churn symbol with a fresh qualified"
- `packages/bench/src/coding-graph/harness.ts:300` — "// name + bumped content hash forces the store to delete the file's"
- `packages/bench/src/coding-graph/harness.ts:301` — "// prior symbols/edges and create new ones (the change-heavy path)."
- `packages/bench/src/coding-graph/harness.ts:302` — "// Carry a couple of the original's CROSS-FILE edges (re-pointed at"
- `packages/bench/src/coding-graph/harness.ts:303` — "// the churn symbol) so the timed upsert also measures edge CREATION"
- `packages/bench/src/coding-graph/harness.ts:304` — "// + resolution, not just pruning + a node insert — matching the"
- `packages/bench/src/coding-graph/harness.ts:305` — "// metric's \"edge deletion/creation\" contract (#1688 review: codex)."
- `packages/bench/src/coding-graph/harness.ts:306` — "// Cross-file dsts are filtered so the edges resolve against symbols"
- `packages/bench/src/coding-graph/harness.ts:307` — "// that survive the churn (the file's own symbols are pruned)."
- `packages/bench/src/coding-graph/harness.ts:334` — "// Restore the FULL fixture so the graph returns to baseline."
- `packages/bench/src/coding-graph/harness.ts:335` — "// Restoring only this file leaves peer files' incoming edges —"
- `packages/bench/src/coding-graph/harness.ts:336` — "// cascade-deleted by the churn prune (the store's FK ON DELETE"
- `packages/bench/src/coding-graph/harness.ts:337` — "// CASCADE drops every edge whose endpoint is a pruned node) —"
- `packages/bench/src/coding-graph/harness.ts:338` — "// unrecreated: the graph would shed cross-file edges each pass"
- `packages/bench/src/coding-graph/harness.ts:339` — "// and later samples would time a progressively smaller graph"
- `packages/bench/src/coding-graph/harness.ts:340` — "// (chatgpt-codex-connector + cursor review of #1688). Inspect"
- `packages/bench/src/coding-graph/harness.ts:341` — "// the result so a failed restore throws instead of leaving the"
- `packages/bench/src/coding-graph/harness.ts:342` — "// graph on the churn symbol set (cursor review of #1688). The"
- `packages/bench/src/coding-graph/harness.ts:343` — "// restore is NOT timed — only the churn upsert above is"
- `packages/bench/src/coding-graph/harness.ts:344` — "// measured."
- `packages/bench/src/coding-graph/index.ts:1` — "/** * Coding-graph benchmark suite — public re-exports (issue #1557). * * The CLI reaches this surface only through the "
- `packages/bench/src/coding-graph/regression.ts:1` — "/** * Coding-graph regression gate (issue #1557 step 3). * * Compares a benchmark report against a tracked baseline with"
- `packages/bench/src/coding-graph/regression.ts:76` — "// cpuModel is nullable — null means \"unknown / undetected\", not \"different\"."
- `packages/bench/src/coding-graph/regression.ts:77` — "// Only count a cpuModel difference when BOTH sides report a concrete model,"
- `packages/bench/src/coding-graph/regression.ts:78` — "// so a null cpuModel does not spuriously skip the gate and hide a real"
- `packages/bench/src/coding-graph/regression.ts:79` — "// regression on the same machine class (cursor Bugbot: 'Fingerprint skip"
- `packages/bench/src/coding-graph/regression.ts:80` — "// omits cpuModel validation')."
- `packages/bench/src/coding-graph/regression.ts:92` — "/** * Validate the load-bearing fields of a machine fingerprint. JSON-loaded * fingerprints bypass TS's nominal types, s"
- `packages/bench/src/coding-graph/regression.ts:105` — "// nodeVersion feeds nodeMajor's .replace — a non-string throws."
- `packages/bench/src/coding-graph/regression.ts:108` — "// cpuModel is nullable (the harness sets null when no CPUs are detected),"
- `packages/bench/src/coding-graph/regression.ts:109` — "// but it must still be a string-or-null — a number/object/undefined (a"
- `packages/bench/src/coding-graph/regression.ts:110` — "// missing key) is corruption (cursor Bugbot: 'Fingerprint skip omits"
- `packages/bench/src/coding-graph/regression.ts:111` — "// cpuModel validation')."
- `packages/bench/src/coding-graph/regression.ts:131` — "// Guard: a regression comparison is only meaningful when the report's"
- `packages/bench/src/coding-graph/regression.ts:132` — "// fixture matches the baseline's fixture on EVERY knob. A different seed"
- `packages/bench/src/coding-graph/regression.ts:133` — "// or language produces a structurally different synthetic repo, so timing"
- `packages/bench/src/coding-graph/regression.ts:134` — "// deltas across mismatched fixtures are meaningless. Compare all keys"
- `packages/bench/src/coding-graph/regression.ts:135` — "// present in the baseline config so new knobs are covered automatically."
- `packages/bench/src/coding-graph/regression.ts:155` — "// Guard: schema-version compatibility. extractMetrics below"
- `packages/bench/src/coding-graph/regression.ts:156` — "// unconditionally dereferences v2-only fields (e.g."
- `packages/bench/src/coding-graph/regression.ts:157` — "// incrementalModifiedUpdate); a pre-v2 report lacks them and would"
- `packages/bench/src/coding-graph/regression.ts:158` — "// throw a TypeError before any skip could run — defeating the"
- `packages/bench/src/coding-graph/regression.ts:159` — "// cross-environment robustness the machine guard targets"
- `packages/bench/src/coding-graph/regression.ts:160` — "// (kilo-code-bot review of #1688). A schema mismatch is a structural"
- `packages/bench/src/coding-graph/regression.ts:161` — "// incompatibility: fail with an actionable message instead of"
- `packages/bench/src/coding-graph/regression.ts:162` — "// crashing or silently skipping."
- `packages/bench/src/coding-graph/regression.ts:174` — "// Field-presence + finite-number guard: a corrupt/partial v2 report"
- `packages/bench/src/coding-graph/regression.ts:175` — "// may carry schemaVersion 2 yet lack a required metric field, have a"
- `packages/bench/src/coding-graph/regression.ts:176` — "// nested sub-field missing, or carry a non-numeric value from a malformed"
- `packages/bench/src/coding-graph/regression.ts:177` — "// JSON (e.g. fullIndexLocsPerSecond: \"oops\"). extractMetrics feeds these"
- `packages/bench/src/coding-graph/regression.ts:178` — "// values into ratio math; a NaN result silently passes the gate. Validate"
- `packages/bench/src/coding-graph/regression.ts:179` — "// every metric as a finite number before comparing or skipping"
- `packages/bench/src/coding-graph/regression.ts:180` — "// (chatgpt-codex-connector #1688 P2: 'Validate metric values as finite')."
- `packages/bench/src/coding-graph/regression.ts:207` — "// Baseline-side metric value guard: the report guard above only"
- `packages/bench/src/coding-graph/regression.ts:208` — "// validates report values. A corrupt baseline JSON could carry a"
- `packages/bench/src/coding-graph/regression.ts:209` — "// non-numeric metric (e.g. fullIndexLocsPerSecond: \"oops\") that reaches"
- `packages/bench/src/coding-graph/regression.ts:210` — "// the comparison loop where measVal / baseVal yields NaN, and NaN >"
- `packages/bench/src/coding-graph/regression.ts:211` — "// tolerance is false so the gate silently passes. The baseline is loaded"
- `packages/bench/src/coding-graph/regression.ts:212` — "// from JSON and carries the regression thresholds, so require every"
- `packages/bench/src/coding-graph/regression.ts:213` — "// PRESENT baseline metric to be a finite number. A metric that is simply"
- `packages/bench/src/coding-graph/regression.ts:214` — "// absent stays additive (skipped below), preserving the \"keys present in"
- `packages/bench/src/coding-graph/regression.ts:215` — "// BOTH\" contract — only a present non-number is corruption"
- `packages/bench/src/coding-graph/regression.ts:216` — "// (chatgpt-codex-connector #1688 P2: 'Validate baseline metrics')."
- `packages/bench/src/coding-graph/regression.ts:233` — "// Machine-fingerprint presence + field-type guard: a corrupt JSON report"
- `packages/bench/src/coding-graph/regression.ts:234` — "// or baseline may carry a null fingerprint OR a fingerprint with wrong-"
- `packages/bench/src/coding-graph/regression.ts:235` — "// typed fields (e.g. machine: {} or nodeVersion as a number)."
- `packages/bench/src/coding-graph/regression.ts:236` — "// compareMachineFingerprints → nodeMajor calls .replace on nodeVersion; a"
- `packages/bench/src/coding-graph/regression.ts:237` — "// non-string throws instead of returning the intended corrupt-artifact"
- `packages/bench/src/coding-graph/regression.ts:238` — "// failure. Reject both missing and wrong-typed fingerprints before"
- `packages/bench/src/coding-graph/regression.ts:239` — "// comparing (chatgpt-codex-connector #1688 P2: 'Validate fingerprint"
- `packages/bench/src/coding-graph/regression.ts:240` — "// field types')."
- `packages/bench/src/coding-graph/regression.ts:256` — "// Guard (#1688 item 2): a timing comparison is only meaningful on the"
- `packages/bench/src/coding-graph/regression.ts:257` — "// same machine class. A baseline carries a fingerprint (arch/platform/"
- `packages/bench/src/coding-graph/regression.ts:258` — "// nodeVersion/cpuModel/cores); a report from a different machine class"
- `packages/bench/src/coding-graph/regression.ts:259` — "// can fail the gate on legitimate hardware variance rather than a real"
- `packages/bench/src/coding-graph/regression.ts:260` — "// regression. When the fingerprints differ on a load-bearing field, SKIP"
- `packages/bench/src/coding-graph/regression.ts:261` — "// the comparison (passed: true + skipped: true) and surface the mismatch"
- `packages/bench/src/coding-graph/regression.ts:262` — "// so a human decides whether cross-machine numbers are comparable."
