# CLI- and env-supplied config values are coerced once at the config boundary

Status: accepted

## Context
`--config key=value` and env vars deliver booleans and numbers as strings. Strict checks (`=== true`, `typeof === 'number'`) silently ignored operator intent: `--config localLlmDisableThinking=false` failed to disable, `--config sharedContextEnabled=true` failed to enable, numeric thresholds fell back to defaults. Downstream call sites reading raw values saw the wrong type.

## Decision
All boolean config keys coerce boolean-like strings ("true"/"1"/"yes"/"on" to true; "false"/"0"/"no"/"off" to false) via the shared coerceBool helper; all numeric keys coerce string forms via the shared coerceNumber/coerceNonNegativeInt helpers. Coercion happens once, where the value enters the config object; downstream code reads the coerced value and must not re-coerce. Range clamping is a separate layer applied after coercion. Unrecognized string values are rejected, not defaulted. A gateway/base-URL string is normalized to avoid duplicate trailing slashes before path joins.

## Consequences
Two layers (coerce then clamp) must be kept separate; inlining them was a recurring source of post-merge fixes. Values are stored coerced so persisted config files contain real booleans/numbers, which later provenance checks rely on.

## Origin comments
- `packages/remnic-core/src/config.test.ts:1352` — "// `--config localLlmDisableThinking=false` arrives as string; must"
- `packages/remnic-core/src/config.test.ts:1353` — "// coerce or the opt-out silently fails."
- `packages/remnic-core/src/config.test.ts:1517` — "// CLI-style `"false"` string must also coerce to off (CLAUDE.md rule 36)."
- `packages/remnic-core/src/config.test.ts:1580` — "// CLAUDE.md #36: string "false" must coerce to boolean false."
- `packages/remnic-core/src/config.test.ts:2674` — "// Boolean coerced via the shared helper (string "false" must disable, not read"
- `packages/remnic-core/src/config.test.ts:2675` — "// as truthy — gotcha #36)."
- `packages/remnic-core/src/config.test.ts:2835` — "// `--config sharedContextAllowBindingAuthority=true` arrives as a string, so a"
- `packages/remnic-core/src/config.test.ts:2836` — "// strict `=== true` silently left the feature off for anyone who enabled it."
- `packages/remnic-core/src/config.test.ts:2853` — "// `--config sharedContextEnabled=true` arrives as a string, so a strict"
- `packages/remnic-core/src/config.test.ts:2854` — "// `=== true` silently left the feature off for anyone who enabled it."
- `packages/remnic-core/src/config.test.ts:2855` — "// Parity with sharedContextAllowBindingAuthority (issue #2918)."
- `packages/remnic-core/src/config.test.ts:2856` — "// The default recall-pipeline shared-context gate must use the same"
- `packages/remnic-core/src/config.test.ts:2857` — "// coerced boolean — string true with no custom pipeline enables the"
- `packages/remnic-core/src/config.test.ts:2858` — "// section; false/malformed stay off."
- `packages/remnic-core/src/config.ts:526` — "// Avoid duplicate slash behavior in downstream baseURL path joins."
- `packages/remnic-core/src/config.ts:1510` — "// Coerce once. The default recall-pipeline shared-context gate reads"
- `packages/remnic-core/src/config.ts:1511` — "// `cfg.sharedContextEnabled === true`, so it must see this boolean —"
- `packages/remnic-core/src/config.ts:1512` — "// not the raw CLI/config string. Custom `recallPipeline` is unchanged."
- `packages/remnic-core/src/config.ts:1614` — "// Numeric surprise knobs go through `coerceNumber` so CLI operators"
- `packages/remnic-core/src/config.ts:1615` — "// can pass `--config bufferSurpriseThreshold=0.5` without the string"
- `packages/remnic-core/src/config.ts:1616` — "// silently dropping to the default. Matches the coercion contract"
- `packages/remnic-core/src/config.ts:1617` — "// applied to other numeric config keys (CLAUDE.md rule #28)."
- `packages/remnic-core/src/config.ts:2333` — "// At-rest encryption (#690): coerceBool handles CLI string "true" (#36)."
- `packages/remnic-core/src/config.ts:2580` — "// Async peer profile reasoner (issue #679 PR 2/5). Defaults to"
- `packages/remnic-core/src/config.ts:2581` — "// `false` (opt-in) per Gotchas #30/#48 — least-privileged default."
- `packages/remnic-core/src/config.ts:2582` — "// `coerceBool` handles "true"/"1"/"yes"/"on" CLI strings (Gotcha"
- `packages/remnic-core/src/config.ts:2583` — "// #36). Numeric thresholds clamp at zero (Gotcha #28 + #45 — 0"
- `packages/remnic-core/src/config.ts:2584` — "// is a documented disable value for both, so the schema minimum"
- `packages/remnic-core/src/config.ts:2585` — "// matches and we do NOT silently bump to 1)."
- `packages/remnic-core/src/config.ts:2597` — "// Cursor L on PR #736: numeric config keys must coerce string CLI"
- `packages/remnic-core/src/config.ts:2598` — "// values (Gotcha #28 — `--config peerProfileReasonerMaxFieldsPerRun=2`"
- `packages/remnic-core/src/config.ts:2599` — "// arrives as the string "2"). Pre-fix `typeof === "number"`"
- `packages/remnic-core/src/config.ts:2600` — "// rejected string inputs and silently fell back to defaults. The"
- `packages/remnic-core/src/config.ts:2601` — "// shared `coerceNonNegativeInt` helper accepts both forms, throws"
- `packages/remnic-core/src/config.ts:2602` — "// on invalid input (Gotcha #51 — reject rather than silently"
- `packages/remnic-core/src/config.ts:2603` — "// default), and falls back to the documented default when the"
- `packages/remnic-core/src/config.ts:2604` — "// key is absent. 0 is a valid documented disable value here, so"
- `packages/remnic-core/src/config.ts:2605` — "// the helper does NOT bump to 1."
- `packages/remnic-core/src/config.ts:3034` — "// Reuse the hoisted coerce above (default pipeline already saw it)."
- `packages/remnic-core/src/config.ts:3036` — "// Same coercion contract for the binding-authority sibling (#2918 parity)."
- `packages/remnic-core/src/config.ts:3185` — "// CJK/Thai lexical segmentation (issue #2187) — default on; string forms"
- `packages/remnic-core/src/config.ts:3186` — "// from CLI `--config` are coerced like neighboring boolean flags."
- `packages/remnic-core/src/config.ts:3314` — "// All recallPlanner boolean gates coerce boolean-like strings so CLI/env"
- `packages/remnic-core/src/config.ts:3315` — "// surfaces (`--config recallPlanner*=true|false`) behave correctly — the"
- `packages/remnic-core/src/config.ts:3316` — "// shadow-mode/telemetry/enable flags are documented rollout switches and"
- `packages/remnic-core/src/config.ts:3317` — "// must not silently ignore string values (gotcha #36, #1428 review)."
- `packages/remnic-core/src/config.ts:3670` — "// Coerce string "false"/"0"/"no" → false and "true"/"1"/"yes" → true so"
- `packages/remnic-core/src/config.ts:3671` — "// that CLI inputs like --config installExtension=false are handled correctly."
- `packages/remnic-core/src/config.ts:3672` — "// Missing / undefined defaults to true (coerceInstallExtension returns"
- `packages/remnic-core/src/config.ts:3673` — "// undefined for unknown values, so ?? true applies the default)."
- `packages/remnic-core/src/config.ts:4005` — "// Coerce string booleans from CLI (e.g. --config taxonomyEnabled=true) — gotcha #36"
- `packages/remnic-core/src/config.ts:4060` — "// Legacy MCP tool aliases opt-out (issue #1427). Config field wins; then"
- `packages/remnic-core/src/config.ts:4061` — "// the REMNIC_/ENGRAM_ env var (gotcha #9); default true for back-compat."
- `packages/remnic-core/src/config.ts:4062` — "// Malformed values fail fast rather than silently defaulting (gotcha #51)."
- `packages/remnic-core/src/config.ts:4178` — "// Each helper takes a post-`coerceNumber` value (number | undefined) and a"
- `packages/remnic-core/src/config.ts:4179` — "// fallback. This keeps the coercion layer (coerce CLI strings → number) and"
- `packages/remnic-core/src/config.ts:4180` — "// the range layer (clamp to valid domain) cleanly separated — a common"
- `packages/remnic-core/src/config.ts:4181` — "// source of post-merge fixes when these were inlined (CLAUDE.md rule #28)."
- `packages/remnic-core/src/config.ts:4258` — "// Already coerced in parseConfig; do not coerce again."
