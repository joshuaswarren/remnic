# The published harness validates datasets at the parse boundary and keeps trial output shape stable

Status: accepted

## Context
Published benchmarks (LoCoMo, LongMemEval) ingest third-party datasets whose missing fields historically surfaced as runtime errors deep inside runners (item.haystack_sessions.length, turn.role). The per-item lifecycle was migrated into the shared harness (issue #566 PR 2/7) under a structural ratchet. Judge calls cost real money: unconditionally invoking the judge billed non-judge runs an API call per trial and inflated latency/token totals. Result consumers also depend on output shape - per-category breakdowns, error fields, progress denominators - and repeat trials must stay comparable.

Theme consolidation: this record merges 17 sweep themes into one decision family (61 origin records): category-aggregates-proto-key, dataset-limit-zero, dataset-parse-boundary-validation, dataset-smoke-fallback, harness-category-attribution, harness-determinism, harness-judge-gating, harness-post-answer-hook-ordering, harness-progress-total, harness-trial-error-compat, limit-normalization-single-source, locomo-linked-evidence-no-leak, locomo-strict-parse, longmemeval-order-determinism, published-harness-extraction, task-selection-canonical-order, unreachable-sanity-guard.

## Decision
- Validate dataset structure where it is parsed, not where it is consumed: required arrays the runner dereferences, per-turn role/content shape, string session ids and dates (filter(Boolean) would otherwise silently drop non-string entries). Probe errors must point at the dataset file.
- Quick mode falls back to the bundled smoke fixture when datasetDir is absent or unreadable, surfacing the probe errors so operators know why the real dataset was not used.
- Limit normalization has one source of truth (the shared loader's normalizeLimit); runners never re-validate it. Task selectors resolve into canonical dataset order - explicit selector order never controls execution. LoCoMo parsing is strict and lives in its own module.
- Invoke the LLM judge only when judge-backed metrics are in the spec; a zero-valued placeholder keeps downstream arithmetic unchanged for non-judge runs. Run the post-answer hook before the judge so dataset-specific signals (e.g. LongMemEval search_hits) are observed from the same post-ingest, post-recall state as the recall/answer calls.
- Failed trials keep their category so per-category aggregates stay consistent with the overall counts (issue #1878); the per-category breakdown is omitted when empty so other benchmarks' output shape is unchanged. `error` remains for diagnostics compatibility, but the structured marker is the authoritative run-status signal - a benchmark-owned extraDetails.error must not make a successful trial look failed.
- Progress denominators use the global task count (tasks.length is cumulative across plans; a per-plan divisor overflows to nonsense in plan 2+).
- Between repeated trials only id and timestamp may differ (UUID + wall-clock); every other field must be identical.
- Category aggregate maps are built via Object.fromEntries so a category literally named "__proto__" becomes an own key instead of vanishing through the prototype setter.
- LongMemEval: supersession follows source time, never array position or the gold answer session; aggregation follows the plan's deterministic session order, not completion order.
- LoCoMo: multi-hop composition is query/evidence driven (lexical bridge entities in already-recalled context), never category-label driven.
- Unreachable branches keep their explicit sanity guard (rule 53: enumerate all non-active states).

## Consequences
Adding an optional output field requires the omit-when-empty pattern. Parse-time validation duplicates some runner knowledge but moves failures to the boundary with actionable messages. Non-judge runs save a judge API call per trial and keep latency/token totals honest. Strict determinism (everything but id/timestamp identical) is a hard gate on harness changes.

## Origin comments
- `packages/bench/src/benchmarks/published/category-aggregates.ts:32` — "// Build via Object.fromEntries (own-property define, not assignment) so a"
- `packages/bench/src/benchmarks/published/category-aggregates.ts:33` — "// category literally named \"__proto__\" becomes an own key instead of"
- `packages/bench/src/benchmarks/published/category-aggregates.ts:34` — "// invoking the prototype setter and vanishing from Object.keys."
- `packages/bench/src/benchmarks/published/dataset-loader.test.ts:317` — "// haystack_sessions missing — runner would later crash on"
- `packages/bench/src/benchmarks/published/dataset-loader.test.ts:318` — "// `item.haystack_sessions.length`."
- `packages/bench/src/benchmarks/published/dataset-loader.test.ts:375` — "// conversation missing — runner iterates conversation.session_*"
- `packages/bench/src/benchmarks/published/dataset-loader.ts:149` — "// Quick mode: fall back to the bundled smoke fixture. This keeps CI green"
- `packages/bench/src/benchmarks/published/dataset-loader.ts:150` — "// when `datasetDir` is absent or unreadable while still surfacing the"
- `packages/bench/src/benchmarks/published/dataset-loader.ts:151` — "// probe errors so operators can tell why the real dataset wasn't used."
- `packages/bench/src/benchmarks/published/dataset-loader.ts:198` — "// Required arrays that the runner dereferences directly. Missing any"
- `packages/bench/src/benchmarks/published/dataset-loader.ts:199` — "// of these silently would surface as a runtime error deep inside"
- `packages/bench/src/benchmarks/published/dataset-loader.ts:200` — "// `runLongMemEvalBenchmark`; catch them here so the probe error"
- `packages/bench/src/benchmarks/published/dataset-loader.ts:201` — "// message points at the dataset file."
- `packages/bench/src/benchmarks/published/dataset-loader.ts:222` — "// Walk each haystack session to validate its turn shape. The"
- `packages/bench/src/benchmarks/published/dataset-loader.ts:223` — "// runner maps over `turn.role` + `turn.content` — catch missing"
- `packages/bench/src/benchmarks/published/dataset-loader.ts:224` — "// fields at parse time so runtime failures surface at the dataset"
- `packages/bench/src/benchmarks/published/dataset-loader.ts:225` — "// boundary."
- `packages/bench/src/benchmarks/published/dataset-loader.ts:261` — "// Haystack session IDs and dates must be strings; `filter(Boolean)`"
- `packages/bench/src/benchmarks/published/dataset-loader.ts:262` — "// in the runner would otherwise silently drop non-string entries."
- `packages/bench/src/benchmarks/published/dataset-loader.ts:409` — "// CLAUDE.md rule 27: slice(-0) returns all items. Treat `0` as \"empty\"."
- `packages/bench/src/benchmarks/published/harness.test.ts:1215` — "// `id` and `timestamp` are non-deterministic by design (UUID +"
- `packages/bench/src/benchmarks/published/harness.test.ts:1216` — "// wall-clock). Every other field must be identical."
- `packages/bench/src/benchmarks/published/harness.ts:393` — "// Pass the GLOBAL total (ctx.totalCount), not a per-plan total —"
- `packages/bench/src/benchmarks/published/harness.ts:394` — "// `tasks.length` is cumulative across every plan in ctx.plans, so a"
- `packages/bench/src/benchmarks/published/harness.ts:395` — "// per-plan divisor would overflow to \"N/3\" nonsense in plan 2+."
- `packages/bench/src/benchmarks/published/harness.ts:440` — "// Preserve the trial's category so a failed trial is still attributed"
- `packages/bench/src/benchmarks/published/harness.ts:441` — "// to its per-category bucket (computeCategoryAggregates), keeping the"
- `packages/bench/src/benchmarks/published/harness.ts:442` — "// per-category breakdown consistent with the overall aggregates that"
- `packages/bench/src/benchmarks/published/harness.ts:443` — "// already count this failure row (issue #1878)."
- `packages/bench/src/benchmarks/published/harness.ts:447` — "// `error` is retained for compatibility with existing diagnostics."
- `packages/bench/src/benchmarks/published/harness.ts:448` — "// The structured marker is the authoritative run-status signal; an"
- `packages/bench/src/benchmarks/published/harness.ts:449` — "// arbitrary benchmark-owned `extraDetails.error` must not make a"
- `packages/bench/src/benchmarks/published/harness.ts:450` — "// successful trial look failed."
- `packages/bench/src/benchmarks/published/harness.ts:716` — "// Post-answer hook runs before the judge so dataset-specific signals"
- `packages/bench/src/benchmarks/published/harness.ts:717` — "// (e.g. LongMemEval `search_hits`) are observed from the same"
- `packages/bench/src/benchmarks/published/harness.ts:718` — "// post-ingest, post-recall system state as the recall/answer calls."
- `packages/bench/src/benchmarks/published/harness.ts:727` — "// Only invoke the LLM judge when judge-backed metrics are in the spec."
- `packages/bench/src/benchmarks/published/harness.ts:728` — "// Cursor review feedback on PR 596: unconditionally calling the judge"
- `packages/bench/src/benchmarks/published/harness.ts:729` — "// billed non-judge runs for an API call per trial and inflated the"
- `packages/bench/src/benchmarks/published/harness.ts:730` — "// `TaskResult` latency/token totals. The zero-valued placeholder"
- `packages/bench/src/benchmarks/published/harness.ts:731` — "// below keeps the downstream arithmetic unchanged for runs that"
- `packages/bench/src/benchmarks/published/harness.ts:732` — "// don't opt into the judge."
- `packages/bench/src/benchmarks/published/harness.ts:769` — "// Unreachable — validated in validateContext. Keep as a sanity"
- `packages/bench/src/benchmarks/published/harness.ts:770` — "// guard; CLAUDE.md rule 53 (enumerate all non-active states)."
- `packages/bench/src/benchmarks/published/harness.ts:1050` — "// Per-category breakdown for benchmarks that stamp a `categoryName`"
- `packages/bench/src/benchmarks/published/harness.ts:1051` — "// detail (LoCoMo). Omitted when empty so other benchmarks' output shape"
- `packages/bench/src/benchmarks/published/harness.ts:1052` — "// is unchanged (issue #1878)."
- `packages/bench/src/benchmarks/published/locomo/multi-hop-composition.test.ts:125` — "// Deliberately not the LoCoMo multi-hop category: composition must be"
- `packages/bench/src/benchmarks/published/locomo/multi-hop-composition.test.ts:126` — "// query/evidence driven rather than category-label driven."
- `packages/bench/src/benchmarks/published/locomo/runner.ts:1` — "/** * LoCoMo runner migrated into @remnic/bench for phase 1. * * As of issue #566 PR 2/7, the per-item lifecycle (res…"
- `packages/bench/src/benchmarks/published/locomo/runner.ts:1150` — "/** * Expand question-matching recall lines through lexical bridge entities that * occur in the already-recalled cont…"
- `packages/bench/src/benchmarks/published/locomo/runner.ts:1510` — "// Limit normalization happens inside `loadLoCoMo10`; do not re-validate"
- `packages/bench/src/benchmarks/published/locomo/runner.ts:1511` — "// here (the shared loader's `normalizeLimit` is the single source of"
- `packages/bench/src/benchmarks/published/locomo/runner.ts:1512` — "// truth)."
- `packages/bench/src/benchmarks/published/locomo/strict-parse.ts:1` — "/** * Strict LoCoMo dataset parsing for the runner path (extracted from * runner.ts under the structural ratchet, iss…"
- `packages/bench/src/benchmarks/published/locomo/task-selection.ts:126` — "/** * Resolve a LoCoMo task selector into canonical dataset order. * * Explicit selector order never controls executi…"
- `packages/bench/src/benchmarks/published/longmemeval/runner.test.ts:293` — "// Deliberately reverse chronological ingest order. Supersession must"
- `packages/bench/src/benchmarks/published/longmemeval/runner.test.ts:294` — "// follow source time, not array position or the gold answer session."
- `packages/bench/src/benchmarks/published/longmemeval/runner.test.ts:321` — "// Complete the second session first to prove aggregation follows the"
- `packages/bench/src/benchmarks/published/longmemeval/runner.test.ts:322` — "// plan's deterministic session order rather than completion order."
- `packages/bench/src/benchmarks/published/longmemeval/runner.ts:1` — "/** * LongMemEval runner migrated into @remnic/bench for phase 1. * * As of issue #566 PR 2/7, the per-item lifecycle…"
