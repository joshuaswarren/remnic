# Config resolvers distinguish operator-authored values from schema-default materialization

Status: accepted

## Context
OpenClaw applies manifest schema defaults (applyDefaults: true) before the config reaches parseConfig, so the set of keys present in a config object cannot reliably distinguish a value the operator wrote from a default the loader injected. Resolvers that treat any present key as operator intent silently mask sticky-legacy fallbacks and runtime overrides; resolvers that ignore present keys drop runtime overrides. Earlier attempts (a runtimeSet gate, key-presence checks) were reverted after review rounds showed both directions of the bug.

## Decision
Config resolvers must consult the raw operator config ONLY to detect authorship, and must treat the merged configValue as authoritative whenever it differs from the schema default (the `configValue !== SCHEMA_DEFAULT` contract). A raw value of null/undefined counts as absent, and a null operator-config block normalizes to {} so key-presence checks never throw. The raw-vs-effective split is pinned by tests so a future schema default flip cannot silently reintroduce the bug class.

## Consequences
Runtime overrides always win over on-disk files (matching the runtime-over-file spread at the call site). The raw object no longer changes resolver behavior on its own; key-presence-based gates cannot be reintroduced without breaking pinned tests.

## Origin comments
- `packages/remnic-core/src/config.test.ts:178` — "// operator file). Resolvers check `rawOperatorConfig` first — if the key is"
- `packages/remnic-core/src/config.test.ts:179` — "// absent there, the present value is treated as a schema default and the"
- `packages/remnic-core/src/config.test.ts:180` — "// env / sticky-legacy fallback chain runs."
- `packages/remnic-core/src/config.test.ts:196` — "// When raw author wrote a real value but the merged configValue"
- `packages/remnic-core/src/config.test.ts:197` — "// disagrees, configValue wins (matches the runtime-over-file spread in"
- `packages/remnic-core/src/config.test.ts:198` — "// src/index.ts — chatgpt-codex-connector P2, PR #1593 round 4)."
- `packages/remnic-core/src/config.test.ts:207` — "// Upgraded install with legacy connector JSON on disk: schema-default"
- `packages/remnic-core/src/config.test.ts:208` — "// `false` in merged config MUST NOT mask the sticky-legacy fallback. This"
- `packages/remnic-core/src/config.test.ts:209` — "// is the exact Cursor Bugbot scenario."
- `packages/remnic-core/src/config.test.ts:233` — "// Same-class hardening as emitLegacyTools: if a future schema revision flips"
- `packages/remnic-core/src/config.test.ts:234` — "// namespaceCatalogEnabled's default to `false`, the resolver must still let"
- `packages/remnic-core/src/config.test.ts:235` — "// the sticky / absent chain run unless the operator wrote the key. Today"
- `packages/remnic-core/src/config.test.ts:236` — "// the schema default is `true`, so the bug doesn't manifest — but the helper"
- `packages/remnic-core/src/config.test.ts:237` — "// now has the raw-vs-effective split, and this test pins the contract so a"
- `packages/remnic-core/src/config.test.ts:238` — "// future schema flip can't reintroduce the bug class silently."
- `packages/remnic-core/src/config.test.ts:264` — "// Merged value wins over raw value when both are present — matches"
- `packages/remnic-core/src/config.test.ts:265` — "// the runtime-over-file spread in src/index.ts."
- `packages/remnic-core/src/config.test.ts:281` — "// Cursor Bugbot round 2: when raw has the key but its value is `null`"
- `packages/remnic-core/src/config.test.ts:282` — "// (operator explicitly cleared it in openclaw.json), the old resolver"
- `packages/remnic-core/src/config.test.ts:283` — "// threw via coerceBooleanLikeOrThrow. New behavior: treat null/undefined"
- `packages/remnic-core/src/config.test.ts:284` — "// in raw as "absent" and fall through to merged / env / sticky-legacy."
- `packages/remnic-core/src/config.test.ts:304` — "// Cursor Bugbot round 2: schema default is `false`. When raw is missing"
- `packages/remnic-core/src/config.test.ts:305` — "// the key but merged carries `true` (runtime gateway set it), the old"
- `packages/remnic-core/src/config.test.ts:306` — "// resolver dropped the runtime override as schema-default materialization."
- `packages/remnic-core/src/config.test.ts:307` — "// New behavior: if merged value differs from the schema default, treat"
- `packages/remnic-core/src/config.test.ts:308` — "// it as runtime operator intent and honor it."
- `packages/remnic-core/src/config.test.ts:327` — "// Cursor Bugbot + kilo-code-bot round 3: a JSON `null` on disk for the"
- `packages/remnic-core/src/config.test.ts:328` — "// operator config block surfaces as `null` at the second argument (the"
- `packages/remnic-core/src/config.test.ts:329` — "// loader's `as Record | undefined` cast previously hid this). Both"
- `packages/remnic-core/src/config.test.ts:330` — "// resolvers now normalize `null` to `{}` so the `"key" in raw` check"
- `packages/remnic-core/src/config.test.ts:331` — "// never throws and the schema-default-detection logic still runs."
- `packages/remnic-core/src/config.test.ts:2155` — "// chatgpt-codex-connector P2: src/index.ts calls parseConfig with"
- `packages/remnic-core/src/config.test.ts:2156` — "// { ...fileConfig, ...api.pluginConfig } where the spread means runtime"
- `packages/remnic-core/src/config.test.ts:2157` — "// overrides file. The resolver must honor configValue (the merged"
- `packages/remnic-core/src/config.test.ts:2158` — "// object) as authoritative when both raw and configValue are present."
- `packages/remnic-core/src/config.test.ts:2159` — "// raw is consulted only to detect "operator authored" vs "schema-default"
- `packages/remnic-core/src/config.test.ts:2160` — "// materialization" — NOT to override configValue."
- `packages/remnic-core/src/config.test.ts:2162` — "// Scenario: file says emitLegacyTools: false, runtime says"
- `packages/remnic-core/src/config.test.ts:2163` — "// api.pluginConfig.emitLegacyTools: true. The merged configValue is"
- `packages/remnic-core/src/config.test.ts:2164` — "// true; the resolver must honor the runtime override, not the file."
- `packages/remnic-core/src/config.test.ts:2210` — "// Cursor Bugbot + chatgpt-codex-connector P2 (round 5, flagged against"
- `packages/remnic-core/src/config.test.ts:2211` — "// round-3 commit ee58f92f/34316d5e): when raw has the key with a"
- `packages/remnic-core/src/config.test.ts:2212` — "// null/undefined value, the previous resolver skipped the merged"
- `packages/remnic-core/src/config.test.ts:2213` — "// configValue entirely. The round-4 rewrite (6c3ca83e) fixed this via"
- `packages/remnic-core/src/config.test.ts:2214` — "// the `configValue !== SCHEMA_DEFAULT` check — the resolver honors"
- `packages/remnic-core/src/config.test.ts:2215` — "// configValue whenever it differs from the schema default, regardless"
- `packages/remnic-core/src/config.test.ts:2216` — "// of whether raw authored the key."
- `packages/remnic-core/src/config.test.ts:2218` — "// This test pins the contract so a future refactor cannot reintroduce"
- `packages/remnic-core/src/config.test.ts:2258` — "// chatgpt-codex-connector P1 round 8 (PR #1593, src/index.ts:1348):"
- `packages/remnic-core/src/config.test.ts:2259` — "// the round-7 runtimeSet gate was reverted because OpenClaw's loader"
- `packages/remnic-core/src/config.test.ts:2260` — "// runs `applyDefaults: true` before exposing `api.pluginConfig`, so the"
- `packages/remnic-core/src/config.test.ts:2261` — "// set of keys present there cannot reliably distinguish operator-authored"
- `packages/remnic-core/src/config.test.ts:2262` — "// values from schema-default materialization. The resolver now relies"
- `packages/remnic-core/src/config.test.ts:2263` — "// solely on the `configValue !== SCHEMA_DEFAULT` comparison (round-4"
- `packages/remnic-core/src/config.test.ts:2264` — "// contract). This test pins that contract for both gates."
- `packages/remnic-core/src/config.test.ts:2265` — "//"
- `packages/remnic-core/src/config.test.ts:2267` — "// API stability but no longer changes resolver behavior."
