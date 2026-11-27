# The regression gate fails on structural violations before considering hardware skips, and evidence receipts are pinned and create-only

Status: accepted

## Context
The coding-graph perf gate compares reports across machines and runs. History: asserting wall-clock reproducibility between two live runs flaked on untouched branches and blocked releases; corrupt baselines made measVal / baseVal = number / "oops" = NaN, and NaN > tolerance is false, so the gate silently PASSED; a machine-fingerprint skip masked a fixture mismatch; a pre-v2 report crashed extractMetrics with a TypeError on a v2-only field instead of failing clearly. The build-week evidence receipt publishes public artifacts whose integrity depends on pinning.

Theme consolidation: this record merges 10 sweep themes into one decision family (86 origin records): benchmark-measurement-methodology, build-week-create-only-publication, build-week-legacy-artifact-pin, build-week-manifest-hash-schemes, build-week-pinned-corpus-identity, build-week-service-tier-null, deterministic-gate-testing, machine-fingerprint-skip-semantics, modified-loop-full-fixture-restore, regression-gate-guard-ordering.

## Decision
- Guard ordering is fixed: structural invariants (fixture identity, schema version, field presence at matching schemaVersion, baseline metric types and finiteness, fingerprint field types) are checked BEFORE the machine-fingerprint skip. A misconfigured run on a different machine fails on its real problem; it is never silently skipped as "hardware variance".
- A genuine machine-class mismatch skips the comparison (passed: true with skipped: true) rather than failing CI on legitimate hardware variance; cpuModel null means "unknown" and compares normally when every other field matches, while concrete-but-different models still skip. Memory differences alone do not justify a skip - memory rarely moves sub-ms SQLite operations, and over-triggering the skip hides real regressions.
- A present-but-non-finite or wrong-typed baseline value fails the gate loudly; a missing key is the documented additive case and is skipped, not treated as corruption (the keys-present-in-BOTH contract stays intact).
- The tolerance contract is tested deterministically: perturb the BASELINE by a known factor in each metric's own regressing direction (lower-is-better baselines below the measured value, higher-is-better baselines above it) and assert the verdict - ratio math with no wall-clock coupling - never by running the benchmark twice on shared CI hardware.
- Incremental modified-content loops re-ingest the full fixture so cross-file edges that the churn prune cascade-deleted are restored; restoring only the churned file shrinks the graph each pass. Modified-content p50 >= idempotent p50 is a defensive lower bound, not a strict performance assertion.
- Evidence receipts: the generated MemCorrect corpus identity is a pinned payload-hash literal; only the historical Build Week run may use its source-verified canonical timestamp implicitly (its exact result bytes, identity, and source commit are pinned); transport service-tier stays null in the receipt when BenchmarkResult does not persist it - never inferred from provider type; file-backed benchmarks hash their sorted file inventory while generated benchmarks hash generator identity; publication is create-only (O_EXCL defeats both leaf substitution and parent-directory swaps - regenerating a public receipt requires a new path or explicit removal outside this boundary); an fstat failure during cleanup must not strand an otherwise writable create-only output before the guarded publication flow begins.

## Consequences
Corrupt or mismatched inputs fail with actionable messages instead of NaN passes or TypeErrors. Skips are explicit in the report so skipped can never read as quietly passed. Receipts are immutable once published, and historical artifacts stay byte-pinned.

## Origin comments
- `packages/bench/src/build-week-evidence-receipt.ts:16` — "/** * Pinned identity of the deterministic, generated MemCorrect v1 full corpus. * Keep the payload hash literal: a gene"
- `packages/bench/src/build-week-evidence-receipt.ts:171` — "// The immutable Build Week run predates persistence of `nowIso`. Its exact"
- `packages/bench/src/build-week-evidence-receipt.ts:172` — "// result bytes, identity, and source commit are pinned so only that historical"
- `packages/bench/src/build-week-evidence-receipt.ts:173` — "// artifact may use the source-verified canonical timestamp implicitly."
- `packages/bench/src/build-week-evidence-receipt.ts:567` — "// BenchmarkResult does not persist transport service-tier diagnostics."
- `packages/bench/src/build-week-evidence-receipt.ts:568` — "// Keep the public receipt honest instead of inferring a tier from provider type."
- `packages/bench/src/build-week-evidence-receipt.ts:983` — "// File-backed benchmarks hash the sorted file inventory. Generated"
- `packages/bench/src/build-week-evidence-receipt.ts:984` — "// MemCorrect hashes its pinned generator identity instead."
- `packages/bench/src/build-week-evidence-receipt.ts:1084` — "// Publish create-only. O_EXCL prevents both a leaf substitution and a"
- `packages/bench/src/build-week-evidence-receipt.ts:1085` — "// parent-directory swap from replacing any existing private source entry."
- `packages/bench/src/build-week-evidence-receipt.ts:1086` — "// Callers that intentionally regenerate a public receipt must choose a new"
- `packages/bench/src/build-week-evidence-receipt.ts:1087` — "// path or remove the prior public artifact outside this safety boundary."
- `packages/bench/src/build-week-evidence-receipt.ts:1097` — "// File identity is needed only to remove a failed publication safely."
- `packages/bench/src/build-week-evidence-receipt.ts:1098` — "// An fstat failure must not itself strand an otherwise writable,"
- `packages/bench/src/build-week-evidence-receipt.ts:1099` — "// create-only output before the guarded publication flow begins."
- `packages/bench/src/coding-graph/harness.test.ts:155` — "// Incremental MODIFIED-content update distribution (#1688 item 1) — the"
- `packages/bench/src/coding-graph/harness.test.ts:156` — "// change-heavy path. It does strictly more work than the idempotent no-op,"
- `packages/bench/src/coding-graph/harness.test.ts:157` — "// so p50 should be >= the idempotent p50 (defensive lower bound; not a"
- `packages/bench/src/coding-graph/harness.test.ts:158` — "// strict perf assertion since both are sub-ms and noisy)."
- `packages/bench/src/coding-graph/harness.test.ts:217` — "// History (#1688, #1838): this test used to run the benchmark TWICE and"
- `packages/bench/src/coding-graph/harness.test.ts:218` — "// assert the two wall-clock reports stayed within tolerance. That asserts"
- `packages/bench/src/coding-graph/harness.test.ts:219` — "// a statistical property of a shared CI runner, not a property of the"
- `packages/bench/src/coding-graph/harness.test.ts:220` — "// gate, and it flaked on untouched branches AND blocked two release runs"
- `packages/bench/src/coding-graph/harness.test.ts:221` — "// on 2026-07-11 even after the #1688 hardening. The tolerance contract is"
- `packages/bench/src/coding-graph/harness.test.ts:222` — "// deterministic when tested like the prove-fail test below: perturb the"
- `packages/bench/src/coding-graph/harness.test.ts:223` — "// BASELINE by a known factor and assert the gate's verdict. Each metric is"
- `packages/bench/src/coding-graph/harness.test.ts:224` — "// moved 20% into ITS OWN regressing direction: lower-is-better (ms, bytes)"
- `packages/bench/src/coding-graph/harness.test.ts:225` — "// baselines sit below the measured value so the measurement reads as a"
- `packages/bench/src/coding-graph/harness.test.ts:226` — "// +20% slowdown; higher-is-better (LOC/s) baselines sit ABOVE the measured"
- `packages/bench/src/coding-graph/harness.test.ts:227` — "// value so the measurement reads as a 20% throughput drop"
- `packages/bench/src/coding-graph/harness.test.ts:228` — "// (chatgpt-codex-connector #1843 P2). Both are 20% in the regressing"
- `packages/bench/src/coding-graph/harness.test.ts:229` — "// direction - ratio math, no wall-clock coupling - strictly below the 30%"
- `packages/bench/src/coding-graph/harness.test.ts:230` — "// tolerance, so the gate MUST pass outright. No stable-metric waiver."
- `packages/bench/src/coding-graph/harness.test.ts:494` — "// 7. Machine-fingerprint guard (#1688 item 2) — a baseline from a different"
- `packages/bench/src/coding-graph/harness.test.ts:495` — "// machine class must SKIP the comparison (passed: true + skipped: true),"
- `packages/bench/src/coding-graph/harness.test.ts:496` — "// not fail CI on legitimate hardware variance."
- `packages/bench/src/coding-graph/harness.test.ts:607` — "// Memory alone rarely moves sub-ms SQLite ops; over-triggering the skip"
- `packages/bench/src/coding-graph/harness.test.ts:608` — "// on memory would hide real regressions. Only memory differs here."
- `packages/bench/src/coding-graph/harness.test.ts:640` — "// 8. Guard ordering (#1688 review) — structural invariants beat the"
- `packages/bench/src/coding-graph/harness.test.ts:641` — "// machine-fingerprint skip. A misconfigured run (wrong fixture or"
- `packages/bench/src/coding-graph/harness.test.ts:642` — "// incompatible schema) on a different machine must FAIL on its real"
- `packages/bench/src/coding-graph/harness.test.ts:643` — "// problem, not be silently skipped as \"hardware variance\"."
- `packages/bench/src/coding-graph/harness.test.ts:647` — "// Report is on a DIFFERENT machine (arch x64) AND has a different"
- `packages/bench/src/coding-graph/harness.test.ts:648` — "// fixture (fileCount 1000 vs 20). Before the reorder this returned"
- `packages/bench/src/coding-graph/harness.test.ts:649` — "// {passed:true, skipped:true} — the machine skip masked the fixture"
- `packages/bench/src/coding-graph/harness.test.ts:650` — "// mismatch. Now the structural fixture check must fail first."
- `packages/bench/src/coding-graph/harness.test.ts:670` — "// A pre-v2 report (schemaVersion 1) compared against a v2 baseline."
- `packages/bench/src/coding-graph/harness.test.ts:671` — "// Before the schema guard, extractMetrics dereferenced the v2-only"
- `packages/bench/src/coding-graph/harness.test.ts:672` — "// incrementalModifiedUpdate field and threw a TypeError. Now the"
- `packages/bench/src/coding-graph/harness.test.ts:673` — "// schema guard fails the gate with an actionable message."
- `packages/bench/src/coding-graph/harness.test.ts:692` — "// Proves the schema guard above is necessary: without it, extractMetrics"
- `packages/bench/src/coding-graph/harness.test.ts:693` — "// deref-crashes on the v2-only field."
- `packages/bench/src/coding-graph/harness.test.ts:703` — "// A corrupt baseline JSON carries fullIndexLocsPerSecond as a string."
- `packages/bench/src/coding-graph/harness.test.ts:704` — "// Before the guard, measVal / baseVal = number / \"oops\" = NaN, and"
- `packages/bench/src/coding-graph/harness.test.ts:705` — "// NaN > tolerance is false so the gate silently PASSED. Now a"
- `packages/bench/src/coding-graph/harness.test.ts:706` — "// present-but-non-finite baseline value fails loudly"
- `packages/bench/src/coding-graph/harness.test.ts:707` — "// (chatgpt-codex-connector #1688 P2: 'Validate baseline metrics')."
- `packages/bench/src/coding-graph/harness.test.ts:727` — "// A baseline that omits a metric (vs. carrying a non-number) is the"
- `packages/bench/src/coding-graph/harness.test.ts:728` — "// documented additive case — the missing key is skipped, not treated as"
- `packages/bench/src/coding-graph/harness.test.ts:729` — "// corruption. This guards against the validation over-reaching and"
- `packages/bench/src/coding-graph/harness.test.ts:730` — "// breaking the \"keys present in BOTH\" contract."
- `packages/bench/src/coding-graph/harness.test.ts:752` — "// A corrupt JSON report carries nodeVersion as a number. Before the"
- `packages/bench/src/coding-graph/harness.test.ts:753` — "// type guard, compareMachineFingerprints → nodeMajor called .replace on"
- `packages/bench/src/coding-graph/harness.test.ts:754` — "// a number and threw. Now the wrong-typed field fails the gate with a"
- `packages/bench/src/coding-graph/harness.test.ts:755` — "// structured message (chatgpt-codex-connector #1688 P2: 'Validate"
- `packages/bench/src/coding-graph/harness.test.ts:756` — "// fingerprint field types')."
- `packages/bench/src/coding-graph/harness.test.ts:783` — "// cpuModel is nullable but must be string-or-null. A numeric/object"
- `packages/bench/src/coding-graph/harness.test.ts:784` — "// value is corruption (cursor Bugbot: 'Fingerprint skip omits cpuModel"
- `packages/bench/src/coding-graph/harness.test.ts:785` — "// validation')."
- `packages/bench/src/coding-graph/harness.test.ts:798` — "// report.cpuModel=null (undetected) vs baseline.cpuModel=\"Apple M2 Max\"."
- `packages/bench/src/coding-graph/harness.test.ts:799` — "// Before the fix, null !== \"Apple M2 Max\" pushed a cpuModel difference"
- `packages/bench/src/coding-graph/harness.test.ts:800` — "// and SKIPPED the gate, hiding a real regression. Now null is treated as"
- `packages/bench/src/coding-graph/harness.test.ts:801` — "// \"unknown\" — with every other field matching, the gate compares normally"
- `packages/bench/src/coding-graph/harness.test.ts:802` — "// (cursor Bugbot: 'Fingerprint skip omits cpuModel validation')."
- `packages/bench/src/coding-graph/harness.test.ts:812` — "// Regression guard for the cpuModel change: when BOTH sides report a"
- `packages/bench/src/coding-graph/harness.test.ts:813` — "// concrete (non-null) but different model, the designed skip still fires."
- `packages/bench/src/coding-graph/harness.test.ts:822` — "// 9. Modified-loop restore (#1688 review) — re-ingesting the full fixture"
- `packages/bench/src/coding-graph/harness.test.ts:823` — "// restores cross-file edges that the churn prune cascade-deleted."
- `packages/bench/src/coding-graph/harness.test.ts:824` — "// Restoring only the churned file leaves peer files' incoming edges"
- `packages/bench/src/coding-graph/harness.test.ts:825` — "// gone, so the graph would shrink each pass."
- `packages/bench/src/coding-graph/harness.test.ts:867` — "// Pick a target that has INCOMING cross-file edges so the"
- `packages/bench/src/coding-graph/harness.test.ts:868` — "// single-file-restore defect is observable below."
- `packages/bench/src/coding-graph/harness.test.ts:933` — "// DEFECT PROOF: re-churn, then restore ONLY the target file (the"
- `packages/bench/src/coding-graph/harness.test.ts:934` — "// old behavior). Cross-file incoming edges stay gone."
- `packages/bench/src/coding-graph/harness.test.ts:958` — "// schemaVersion matches the baseline (both 2) but the v2-only field is"
- `packages/bench/src/coding-graph/harness.test.ts:959` — "// absent (a truncated/hand-edited report). Before the field-presence"
