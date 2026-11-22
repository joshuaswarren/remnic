# Bench adapter corrections are scoped to the owning session and the adapter fails loudly on contract violations

Status: accepted

## Context
Bench "namespaces" are distinct session ids inside one store (real namespaces are disabled), while the correction planner searches the whole default namespace and neighbor expansion can pull same-entityRef siblings from other sessions. Benchmarks measure scope_precision and collateral, so a correction applied to a foreign session - or a silent fallback that mislabels a non-contract run as contract-routed - corrupts the measurement. The adapter also holds state a benchmark must not observe stale: module-level StorageManager caches (including the version-keyed hot-memories result cache, issue #1902), and the QMD debounce timer plus consolidation cadence that moved to MaintenanceScheduler in the #1526 PR1 extraction. Transcripts route per session since #1496, and the recall authority fence changes body offsets, so recorded evidence must point at the post-fence body the responder actually sees.

Theme consolidation: this record merges 10 sweep themes into one decision family (86 origin records): bench-adapter-test-ordering, bench-correction-contract-surface, bench-fence-offset-mapping, bench-metric-contract-fidelity, bench-recall-security-trust, bench-recall-support-classification, bench-session-scoped-corrections, bench-storage-cache-invalidation, maintenance-scheduler-ownership, transcript-session-routing.

## Decision
- Corrections may only target memories extracted for the current session (identified by the per-session replay tag in frontmatter.source). Re-check ownership on the FINAL plan even under explicit targetIds; if a foreign-session target or a same-entityRef twin appears, fail loudly - never apply, never silently fall back to the turn path.
- Session-owned targets with a deterministic empty plan (no classify LLM) also fail loudly rather than routing through the turn path while the run is labeled contract-routed. A `partial` apply outcome is reported as not fully applied so the MemCorrect wrapper delivers the correction through the turn path as well.
- The correction-contract surface (issue #1584 plan item 2a) is built lazily, rebound when rebuild() swaps the orchestrator, and is the same public access layer the MCP/HTTP memory_correct_plan/apply tools use; timeout guarding must preserve it. With an empty store and no classify LLM, correct() deterministically reports { applied: false } and the adapter stays fully usable.
- A full reset clears the module-level StorageManager caches so a post-reset read never serves pre-reset memories. The caller-owned cold directory is written before the adapter opens it; a separate StorageManager rooted there cannot invalidate the corpus read cache.
- MaintenanceScheduler owns consolidation cadence and the QMD debounce timer/in-flight guard; dispose it on teardown so no maintenance pass runs against a torn-down QMD sandbox.
- Session keys resolve through the same identity layer the core transcript writer uses (transcripts/session/<hash>/), and tests track routing through that layer.
- Recall row ranges are computed on the unsecured section and mapped through the fence's offset map; every fenced content line carries its own quote marker (marker count = lines-before + 1), so evidence points land on the post-fence body.
- Recall support is classified from the exact final context sent to the responder (`weak` is an explicit signal), recall guidance sections are instruction-shaped by design, and benchmark judging runs the benchmark-supplied yes/no prompt directly, normalized to 0/1.
- Tests that compare two searches wait out the lazy index initialization: the first search builds the in-memory index, so recall is measured only after that boundary settles.

## Consequences
Degraded lab runs fail loudly instead of mismeasuring. Known limitation: replacement memories written by a previous correction carry the executor's source rather than the session tag - acceptable because MemCorrect issues one correct() per scenario, so no scenario re-corrects its own replacement. Cache clearing and scheduler disposal are mandatory teardown steps; skipping them poisons later scenarios with stale reads or zombie timers.

## Origin comments
- `packages/bench/src/adapters/remnic-adapter.test.ts:217` — "// The first search initializes the in-memory index. Compare two calls only"
- `packages/bench/src/adapters/remnic-adapter.test.ts:218` — "// after that normal lazy-initialization boundary has settled."
- `packages/bench/src/adapters/remnic-adapter.test.ts:266` — "// The first search initializes the in-memory index; recall twice like the"
- `packages/bench/src/adapters/remnic-adapter.test.ts:267` — "// unfenced trace test so the traced call sees the settled index."
- `packages/bench/src/adapters/remnic-adapter.test.ts:328` — "// An unrelated query finds no sections, so recall falls back to the raw"
- `packages/bench/src/adapters/remnic-adapter.test.ts:329` — "// message rows; under the fencing arm those rows are quoted."
- `packages/bench/src/adapters/remnic-adapter.test.ts:1129` — "// Empty store + no classify LLM → the correction planner deterministically"
- `packages/bench/src/adapters/remnic-adapter.test.ts:1130` — "// produces zero actions; correct() must report { applied: false } so the"
- `packages/bench/src/adapters/remnic-adapter.test.ts:1131` — "// MemCorrect wrapper falls back to the turn path, and the adapter must"
- `packages/bench/src/adapters/remnic-adapter.test.ts:1132` — "// stay fully usable afterwards."
- `packages/bench/src/adapters/remnic-adapter.test.ts:2756` — "// The caller-owned directory already holds these cold memories when the"
- `packages/bench/src/adapters/remnic-adapter.test.ts:2757` — "// adapter opens it. A separate StorageManager rooted at cold/ cannot"
- `packages/bench/src/adapters/remnic-adapter.test.ts:2758` — "// invalidate the adapter's corpus read cache, and daemon start now reads the"
- `packages/bench/src/adapters/remnic-adapter.test.ts:2759` — "// corpus early (fact-hash warm-up), so writing after open would be stale."
- `packages/bench/src/adapters/remnic-adapter.test.ts:4344` — "// After issue #1496, an arbitrary session key routes to"
- `packages/bench/src/adapters/remnic-adapter.test.ts:4345` — "// transcripts/session/<hash>/ rather than the legacy shared other/default"
- `packages/bench/src/adapters/remnic-adapter.test.ts:4346` — "// fallback. Resolve the directory through the same identity layer the core"
- `packages/bench/src/adapters/remnic-adapter.test.ts:4347` — "// transcript writer uses so the test tracks routing (rule #20)."
- `packages/bench/src/adapters/remnic-adapter.test.ts:4708` — "// Neighbor expansion pulled a same-entityRef twin back in despite explicit"
- `packages/bench/src/adapters/remnic-adapter.test.ts:4709` — "// targetIds — the caller must fail loudly, never apply."
- `packages/bench/src/adapters/remnic-adapter.ts:178` — "/** * Maintenance scheduler owns the QMD debounce timer after the #1526 PR1 * extraction. The orchestrator used to expos"
- `packages/bench/src/adapters/remnic-adapter.ts:195` — "/** Maintenance scheduler owns consolidation cadence AND QMD debounce state * after the #1526 PR1 extraction; read both "
- `packages/bench/src/adapters/remnic-adapter.ts:203` — "/** Tier migration coordinator owns the in-flight guard after the #1526 * extraction; read it through the coordinator's "
- `packages/bench/src/adapters/remnic-adapter.ts:859` — "/** * Decide how a correction plan may proceed under the bench session-scoping * contract (codex P1 ×2 + cursor Medium o"
- `packages/bench/src/adapters/remnic-adapter.ts:1722` — "// The QMD debounce timer lives on MaintenanceScheduler after the #1526"
- `packages/bench/src/adapters/remnic-adapter.ts:1723` — "// PR1 extraction (the orchestrator no longer exposes"
- `packages/bench/src/adapters/remnic-adapter.ts:1724` — "// qmdMaintenanceTimer/Pending/InFlight). Dispose the scheduler so the"
- `packages/bench/src/adapters/remnic-adapter.ts:1725` — "// live timer is cleared and no maintenance pass runs against the QMD"
- `packages/bench/src/adapters/remnic-adapter.ts:1726` — "// sandbox once it is torn down below."
- `packages/bench/src/adapters/remnic-adapter.ts:1758` — "// A full reset wipes memory files out-of-band (below / in cleanup), so"
- `packages/bench/src/adapters/remnic-adapter.ts:1759` — "// clear the module-level StorageManager caches — including the version-keyed"
- `packages/bench/src/adapters/remnic-adapter.ts:1760` — "// hot-memories result cache (issue #1902) — so a fresh read after the reset"
- `packages/bench/src/adapters/remnic-adapter.ts:1761` — "// never serves pre-reset memories from a warm cache."
- `packages/bench/src/adapters/remnic-adapter.ts:1836` — "// Correction-contract surface (issue #1584 plan item 2a). Built lazily and"
- `packages/bench/src/adapters/remnic-adapter.ts:1837` — "// rebound whenever rebuild() swaps the orchestrator; this is the same"
- `packages/bench/src/adapters/remnic-adapter.ts:1838` — "// public access layer the MCP/HTTP memory_correct_plan/apply tools use,"
- `packages/bench/src/adapters/remnic-adapter.ts:1839` — "// so the benchmark exercises the real correction path, not internals."
- `packages/bench/src/adapters/remnic-adapter.ts:2611` — "// Row ranges are computed on the unsecured section and mapped"
- `packages/bench/src/adapters/remnic-adapter.ts:2612` — "// through the fence's offset map, so recorded evidence points"
- `packages/bench/src/adapters/remnic-adapter.ts:2613` — "// at the post-fence body the responder actually sees."
- `packages/bench/src/adapters/remnic-adapter.ts:2812` — "// The correction executor stamps its own audit timestamps; the seeded"
- `packages/bench/src/adapters/remnic-adapter.ts:2813` — "// corpus timestamp (`_at`) is honored by the turn-path fallback the"
- `packages/bench/src/adapters/remnic-adapter.ts:2814` — "// caller runs when this resolves `{ applied: false }`."
- `packages/bench/src/adapters/remnic-adapter.ts:2828` — "// Bench \"namespaces\" are distinct session ids inside ONE store (real"
- `packages/bench/src/adapters/remnic-adapter.ts:2829` — "// namespaces are disabled), but the correction planner searches the"
- `packages/bench/src/adapters/remnic-adapter.ts:2830` — "// whole default namespace — restrict the plan to memories extracted"
- `packages/bench/src/adapters/remnic-adapter.ts:2831` — "// for THIS session (their frontmatter.source carries the per-session"
- `packages/bench/src/adapters/remnic-adapter.ts:2832` — "// replay tag) so a correction can never plan/apply against another"
- `packages/bench/src/adapters/remnic-adapter.ts:2833` — "// benchmark session's memories and corrupt scope_precision /"
- `packages/bench/src/adapters/remnic-adapter.ts:2834` — "// collateral measurements (codex P1). The scoping decisions live in"
- `packages/bench/src/adapters/remnic-adapter.ts:2835` — "// resolveSessionScopedCorrectionDecision (pure, unit-tested)."
- `packages/bench/src/adapters/remnic-adapter.ts:2836` — "// Limitation: replacement memories written by a previous correction"
- `packages/bench/src/adapters/remnic-adapter.ts:2837` — "// carry the executor's source, not the session tag; MemCorrect"
- `packages/bench/src/adapters/remnic-adapter.ts:2838` — "// issues one correct() per scenario, so no scenario re-corrects its"
- `packages/bench/src/adapters/remnic-adapter.ts:2839` — "// own replacement."
- `packages/bench/src/adapters/remnic-adapter.ts:2869` — "// Re-check ownership on the FINAL plan: even under explicit"
- `packages/bench/src/adapters/remnic-adapter.ts:2870` — "// targetIds the planner's neighbor expansion can pull same-entityRef"
- `packages/bench/src/adapters/remnic-adapter.ts:2871` — "// siblings from another session into the drafted actions (codex P1)."
- `packages/bench/src/adapters/remnic-adapter.ts:2872` — "// Applying such a plan would mutate a foreign session; silently"
- `packages/bench/src/adapters/remnic-adapter.ts:2873` — "// falling back to the turn path would mislabel the measurement —"
- `packages/bench/src/adapters/remnic-adapter.ts:2874` — "// fail loudly instead."
- `packages/bench/src/adapters/remnic-adapter.ts:2889` — "// Session-owned targets were identified (or candidates were"
- `packages/bench/src/adapters/remnic-adapter.ts:2890` — "// located and the classify LLM drafted nothing — the"
- `packages/bench/src/adapters/remnic-adapter.ts:2891` — "// deterministic manual-selection fallback). Silently falling"
- `packages/bench/src/adapters/remnic-adapter.ts:2892` — "// back to the turn path here would measure non-contract"
- `packages/bench/src/adapters/remnic-adapter.ts:2893` — "// behavior while labeling the run contract-routed (codex P1 +"
- `packages/bench/src/adapters/remnic-adapter.ts:2894` — "// cursor Medium on the empty re-plan) — fail loudly instead so"
- `packages/bench/src/adapters/remnic-adapter.ts:2895` — "// a degraded lab run cannot mismeasure."
- `packages/bench/src/adapters/remnic-adapter.ts:2913` — "// A `partial` outcome means at least one action failed — report"
- `packages/bench/src/adapters/remnic-adapter.ts:2914` — "// not-fully-applied so the MemCorrect wrapper also delivers the"
- `packages/bench/src/adapters/remnic-adapter.ts:2915` — "// correction through the turn path (mirrors a user restating after a"
- `packages/bench/src/adapters/remnic-adapter.ts:2916` — "// partial fix) instead of counting a partial apply as full uptake"
- `packages/bench/src/adapters/remnic-adapter.ts:2917` — "// (cursor Medium)."
- `packages/bench/src/adapters/remnic-recall-support.ts:51` — "/** * Recall section ids the harness authors as responder guidance (they are * instruction-shaped by design and may quot"
- `packages/bench/src/adapters/remnic-recall-support.ts:83` — "/** * The authority fence prepends two header lines, prefixes every content line * with a quote marker, and appends one "
- `packages/bench/src/adapters/remnic-recall-support.ts:100` — "// Every content line carries its own quote marker, including the line"
- `packages/bench/src/adapters/remnic-recall-support.ts:101` — "// holding the offset, so the marker count is lines-before plus one."
- `packages/bench/src/adapters/remnic-recall-support.ts:127` — "/** * Rewrite the offset pair named by `startKey`/`endKey` on every receipt from * pre-securing section coordinates into"
- `packages/bench/src/adapters/remnic-recall-support.ts:173` — "/** * Classify support from the exact final context supplied to the responder. * This intentionally avoids auxiliary zer"
- `packages/bench/src/adapters/timeout-guard.ts:235` — "// Preserve the optional correction-contract surface (issue #1584 plan"
- `packages/bench/src/adapters/timeout-guard.ts:236` — "// item 2a) — dropping it here would silently downgrade guarded MemCorrect"
- `packages/bench/src/adapters/timeout-guard.ts:237` — "// runs to the turn-store fallback while still labeling the run"
- `packages/bench/src/adapters/timeout-guard.ts:238` — "// contract-routed (codex P1)."
- `packages/bench/src/adapters/types.ts:64` — "/** * Answer-time support signal for the exact recall text supplied to the * responder. `weak` is intentionally explicit"
- `packages/bench/src/adapters/types.ts:140` — "/** * Run a benchmark-supplied yes/no judging prompt directly and return a * normalized 0/1 score. Published benchmarks "
- `packages/bench/src/adapters/types.ts:188` — "/** * Optionally assess support using the exact, final recall context that will * be sent to the responder. Implementati"
