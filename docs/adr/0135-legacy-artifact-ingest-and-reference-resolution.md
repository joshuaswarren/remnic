# Stored artifacts are validated completely, upgraded from legacy shapes by documented rules, and references resolve store-first

Status: accepted

## Context
Benchmark artifacts accumulate across schema generations. Older artifacts lack provenance and cost fields; JSON payloads carry mistyped optional fields that previously survived casts into typed results, exports, and repro manifests; references to stored runs arrived as ids, basenames, or paths; and benchmark ids had to become safe filenames without collisions or traversal.

This ADR merges the sweep themes: legacy-artifact-validation-strictness, legacy-artifact-ui-parity-defaults, legacy-artifact-provenance-handling, legacy-artifact-cost-zero-policy, benchmark-result-legacy-upgrade, store-first-reference-resolution, publish-feed-skip-classification, published-artifact-stable-schema, filename-sanitization-security, validate-before-mkdir, provenance-fail-closed, persisted-config-adapter-strip, provider-config-single-validator, legacy-eval-benchmarks-single-runtime, result-summary-defensive-coercion, canary-floor-persisted-honor.

Merged sweep themes: legacy-artifact-validation-strictness, legacy-artifact-ui-parity-defaults, legacy-artifact-provenance-handling, legacy-artifact-cost-zero-policy, benchmark-result-legacy-upgrade, store-first-reference-resolution, publish-feed-skip-classification, published-artifact-stable-schema, filename-sanitization-security, validate-before-mkdir, provenance-fail-closed, persisted-config-adapter-strip, provider-config-single-validator, legacy-eval-benchmarks-single-runtime, result-summary-defensive-coercion, canary-floor-persisted-honor.

## Decision
**Artifact loading — canonical first, then documented legacy upgrade (issue #2850):**
- Complete-shape validation (issue #2895): a malformed optional field (e.g. a numeric rubricVersion) rejects with its field path instead of surviving the cast into typed results and exports. Optional pass-through fields reject when present-but-wrong-type so report-card/HTML export never sees a non-string failureReason.
- Absent cost accounting upgrades to ZERO, never to a guess — canonical cost accounting is additive.
- Provenance: ANY single provenance key claims the modern contract. Requiring all three keys let a partially corrupted modern artifact (version and remnicVersion retained, gitSha lost) fall into the legacy path and get its missing marker fabricated as "unknown". A true legacy shape (no markers) gets the honest explicit "unknown" markers, since provenance is not knowable from a legacy artifact.
- Legacy display defaults mirror the old UI: fallback values for absent tier, mode, runCount (task count), providers (none configured), adapter (unknown), and absent task text fields. A task row without a usable taskId has no identity to display and is skipped, not fatal.
- Config extras carry the strict-schema contract (issue #2885): canonical re-validation never checks these fields and invalid values would flow into repro manifests as if typed, so they are validated before copying.
- Persisted result config never contains a live adapter instance: runners may accept one under benchmark options, but it is stripped at the single finalization point where options are merged.
- ProviderConfig has ONE canonical runtime validator (issue #2895), shared by both artifact surfaces; its checked key set is derived from a marker object so a new key cannot be forgotten.

**References and publication:**
- Reference resolution is store-first: a reference is treated as a filesystem path only when it looks like one; stored-run references resolve first (by id or basename), which keeps `runs show <id>` deterministic; paths are canonicalized before dedupe so relative, absolute, and backslash spellings of one file collapse; deletion state is tracked so a path whose file was already deleted is not re-resolved.
- The publication feed classifies rather than throws: a newer public-split or missing-integrity artifact is skipped, not an error.
- The published artifact schema is deliberately flatter and more stable than the internal one.
- Filenames are sanitized character-by-character to `[a-z0-9._-]`; disallowed characters become a single `-` separator (never filter-drop, which collided ids); dot-runs and trailing dots flush to `_`, surviving leading dots are stripped — a single trailing dot is a path-traversal foothold.
- Reporter validates preset/environment BEFORE mkdir so a malformed preset or empty env writes nothing; unknown state fails closed for evidence publication; result summaries coerce defensively and honor a persisted finite canaryFloor so the badge matches the gate that produced the result.
- The five benchmarks the deleted legacy top-level evals tree duplicated remain in the registry and the published-artifact manifest; this package is their only runtime.

## Consequences
Stricter rejection surfaces previously tolerated broken artifacts as load errors. Legacy upgrades are deterministic but frozen — new canonical fields do not backfill into upgraded artifacts. The flat public schema means internal renames require explicit adapters.

## Origin comments
- `packages/bench/src/legacy-artifact.ts:143` — "// Complete-shape validation (issue #2895): a malformed optional field"
- `packages/bench/src/legacy-artifact.ts:144` — "// (e.g. a numeric rubricVersion) rejects with its field path instead of"
- `packages/bench/src/legacy-artifact.ts:145` — "// surviving the cast into typed results and exports."
- `packages/bench/src/legacy-artifact.ts:267` — "// Old UI display default for an absent tier."
- `packages/bench/src/legacy-artifact.ts:269` — "// Provenance is not knowable from a legacy artifact: recognition"
- `packages/bench/src/legacy-artifact.ts:270` — "// rejects any payload with a present provenance key, so the only"
- `packages/bench/src/legacy-artifact.ts:271` — "// honest value here is the explicit \"unknown\" marker."
- `packages/bench/src/legacy-artifact.ts:275` — "// Old UI display default for an absent mode."
- `packages/bench/src/legacy-artifact.ts:277` — "// Old UI fell back to the task count when runCount was absent."
- `packages/bench/src/legacy-artifact.ts:282` — "// Optional pass-through fields: present-but-wrong-type rejects here"
- `packages/bench/src/legacy-artifact.ts:283` — "// so report-card/HTML export never sees a non-string failureReason."
- `packages/bench/src/legacy-artifact.ts:356` — "// Old UI display defaults: no providers configured, adapter unknown."
- `packages/bench/src/legacy-artifact.ts:372` — "// Old UI display default for an absent adapter mode."
- `packages/bench/src/legacy-artifact.ts:386` — "// Config extras carry the strict-schema contract (issue #2885): the"
- `packages/bench/src/legacy-artifact.ts:387` — "// canonical re-validation never checks these fields, so an invalid"
- `packages/bench/src/legacy-artifact.ts:388` — "// value copied here would flow into repro manifests and exports as if"
- `packages/bench/src/legacy-artifact.ts:389` — "// it were typed. Validate before copying."
- `packages/bench/src/legacy-artifact.ts:411` — "// Canonical cost accounting is additive; a legacy artifact that"
- `packages/bench/src/legacy-artifact.ts:412` — "// recorded no usage upgrades to zero, never to a guess."
- `packages/bench/src/legacy-artifact.ts:443` — "// Pre-#2800 UI parity: a task row without a usable taskId has no"
- `packages/bench/src/legacy-artifact.ts:444` — "// identity to display and is skipped, not fatal."
- `packages/bench/src/legacy-artifact.ts:458` — "// Old UI display defaults for absent task text fields."
- `packages/bench/src/legacy-artifact.ts:570` — "// Pass through verbatim; the canonical re-validation in the loader"
- `packages/bench/src/legacy-artifact.ts:571` — "// rejects a present-but-invalid value instead of dropping it."
- `packages/bench/src/legacy-artifact.ts:589` — "// Any single provenance key claims modern provenance. Requiring all"
- `packages/bench/src/legacy-artifact.ts:590` — "// three keys let a partially corrupted modern artifact (e.g. version"
- `packages/bench/src/legacy-artifact.ts:591` — "// and remnicVersion retained, gitSha lost) fall into this legacy"
- `packages/bench/src/legacy-artifact.ts:592` — "// path and get its missing marker fabricated as \"unknown\"."
- `packages/bench/src/provider-config.ts:1` — "/** * Canonical runtime validation for persisted `ProviderConfig` values * (issue #2895). * * Both artifact surfaces sha"
- `packages/bench/src/provider-config.ts:54` — "/** * Every `ProviderConfig` key this validator checks, derived from this * marker object. `satisfies Record<keyof Provi"
- `packages/bench/src/published-artifact.ts:1` — "/** * Public leaderboard artifact schema for published benchmarks. * * `BenchmarkArtifact` is deliberately flatter and m"
- `packages/bench/src/published-artifact.ts:588` — "/** * Sanitize a filename segment. Only `[a-z0-9._-]` survives; any * path-traversal tokens (`..`, `...`, leading/traili"
- `packages/bench/src/published-artifact.ts:628` — "// Flush trailing dots — single trailing dot is a path-traversal"
- `packages/bench/src/published-artifact.ts:629` — "// foothold (\".\"), and a multi-dot run was already dangerous, so"
- `packages/bench/src/published-artifact.ts:630` — "// either way we emit `_`."
- `packages/bench/src/published-artifact.ts:634` — "// Strip any leading dot that survived the initial pass (it can only"
- `packages/bench/src/published-artifact.ts:635` — "// appear as the very first character; the loop would already collapse"
- `packages/bench/src/published-artifact.ts:636` — "// inner dot runs)."
- `packages/bench/src/registry.test.ts:7` — "// The five published benchmarks the legacy top-level evals tree"
- `packages/bench/src/registry.test.ts:8` — "// duplicated before it was deleted (issue #2798). @remnic/bench is the"
- `packages/bench/src/registry.test.ts:9` — "// only runtime for them; this test fails if any of the five ever drops"
- `packages/bench/src/registry.test.ts:10` — "// out of the registry or the published-artifact manifest."
- `packages/bench/src/reporter.ts:276` — "// Validate before mkdir so a malformed preset or empty env writes"
- `packages/bench/src/reporter.ts:277` — "// nothing. A present preset must be a valid floor; otherwise the env"
- `packages/bench/src/reporter.ts:278` — "// parser supplies the override or the canonical 0.1 default."
- `packages/bench/src/reporter.ts:358` — "// Unknown state must fail closed for evidence publication."
- `packages/bench/src/result-config.ts:17` — "// Strip any live adapter instance — benchmark runners (e.g. MemCorrect)"
- `packages/bench/src/result-config.ts:18` — "// accept a MemCorrectSystemAdapter under benchmarkOptions.adapter, but"
- `packages/bench/src/result-config.ts:19` — "// it must never enter the persisted result config. The runner strips it"
- `packages/bench/src/result-config.ts:20` — "// from its own return value, but this merge re-spreads the original"
- `packages/bench/src/result-config.ts:21` — "// options, so filter it here at the single finalization point."
- `packages/bench/src/result-summary.ts:1` — "/** * Rich result summaries for tooling surfaces (bench-ui, /api/results feeds). * * `listBenchmarkResults` in results-s"
- `packages/bench/src/result-summary.ts:197` — "// Results produced under a custom `REMNIC_BENCH_CANARY_FLOOR` may persist"
- `packages/bench/src/result-summary.ts:198` — "// the floor into `meta.canaryFloor`. If present and finite, honor it so"
- `packages/bench/src/result-summary.ts:199` — "// the badge matches the gate that produced the result."
- `packages/bench/src/results-store.test.ts:22` — "// Issue #2850: pre-validator artifacts upgrade with documented"
- `packages/bench/src/results-store.test.ts:51` — "// A true legacy shape carries no provenance markers. A modern artifact"
- `packages/bench/src/results-store.test.ts:69` — "// Absent cost accounting upgrades to zero, never to a guess."
- `packages/bench/src/results-store.test.ts:87` — "// Provenance markers claim the modern contract; a missing required"
- `packages/bench/src/results-store.test.ts:381` — "// Canonical validation rejects the malformed optional field (issue"
- `packages/bench/src/results-store.ts:180` — "// Complete canonical shape (issue #2895): the loader shares the provider"
- `packages/bench/src/results-store.ts:508` — "// Canonical-first, then legacy upgrade (issue #2850): artifacts from"
- `packages/bench/src/results-store.ts:615` — "// Store-first resolution keeps `runs show <id>` deterministic: a"
- `packages/bench/src/results-store.ts:645` — "// A reference is treated as a filesystem path only when it looks like"
- `packages/bench/src/results-store.ts:670` — "// Resolve stored-run references first (by id or basename) so"
- `packages/bench/src/results-store.ts:681` — "// If we've already deleted the file this path points at earlier"
- `packages/bench/src/results-store.ts:702` — "// Canonicalize before dedupe so a relative path and an absolute"
- `packages/bench/src/results-store.ts:882` — "// Classify rather than throw so a newer public-split / missing-integrity"
