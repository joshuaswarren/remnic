# Config resolution: operator-authored values outrank the environment, which outranks host-materialized schema defaults; all surfaces share one discovery order

Status: accepted

## Context
The OpenClaw SDK materializes JSON-schema defaults into `api.pluginConfig` BEFORE `parseConfig` runs, so a fresh install arrived with `emitLegacyTools: false` already populated even though the operator never wrote the key — short-circuiting the sticky-legacy fallback to `hasLegacyConnectorEntries()` and breaking upgrades with legacy connector entries on disk (#1955 memory-poisoning hardening). Separately, daemon, server, CLI, and bridge each discovered config files differently.

## Decision
- Precedence is operator-authored config, then the environment, then a host-materialized schema default: an explicit operator value is preserved, but env values REPLACE schema-materialized defaults — a host that materialized a manifest default into the effective config while the operator's raw config omits the key must not shadow the env override. `parseConfig` accepts the raw pre-defaults operator config (sourced from `loadPluginConfigFromFile`) so a materialized default never masquerades as an operator choice. Origin allow-list parsing stays in the parser module so config-contract extraction cannot drift from it.
- Config-file discovery is ONE shared implementation (#2796) with a fixed candidate order every surface uses: explicit path first. The bridge probes `candidates[0]` and the server/CLI resolver returns the explicit path — same form in, same file out; a daemon the server can discover is never invisible to the bridge. Standalone/legacy config-file shapes resolve into the core config record in one place. QMD settings (#1335): the default plan stays "hybrid" (historical lex+vec+hyde daemon plan) and the query default stays "query" (LLM expansion + rerank, gotcha #7); non-numeric/non-integer timeouts are rejected rather than silently coerced (gotcha #51), and valid integers clamp to documented bounds.

## Consequences
- Env-overrides-materialized-default means environment variables are load-bearing on hosts that baked in defaults; the shared discovery order means adding a candidate location is a one-place change but must keep the bridge and resolvers in lockstep.

## Origin comments
- `packages/remnic-core/src/config-discovery.test.ts:41` — "// The bridge probes candidates[0]; the server/CLI resolver returns the"
- `packages/remnic-core/src/config-discovery.test.ts:42` — "// explicit path. Same form in, same file out — a daemon the server can"
- `packages/remnic-core/src/config-discovery.test.ts:43` — "// discover is never invisible to the bridge."
- `packages/remnic-core/src/config-discovery.ts:1` — "Shared Remnic config-file discovery (issue #2796). One implementation of the candidate order every surface uses: expl..."
- `packages/remnic-core/src/config-qmd.ts:46` — "// Issue #1335. Default "hybrid" preserves the historical lex+vec+hyde daemon plan."
- `packages/remnic-core/src/config-qmd.ts:63` — "// Issue #1335. Reject non-numeric / non-integer timeouts rather than silently"
- `packages/remnic-core/src/config-qmd.ts:64` — "// coercing them (gotcha #51), then clamp valid integers to the documented bounds."
- `packages/remnic-core/src/config-qmd.ts:76` — "// Issue #1335. Default "query" keeps `qmd query` (LLM expansion + rerank) per gotcha #7."
- `packages/remnic-core/src/config-record.ts:5` — "/** Resolve standalone config-file shapes into the core Remnic config record. Legacy files store core keys at the top level..."
- `packages/remnic-core/src/config-security.ts:10` — "// Memory-poisoning hardening (#1955): preserve explicit config, but let env values replace schema-materialized defaults"
- `packages/remnic-core/src/config-security.ts:56` — "// Memory-poisoning hardening (#1955): keep origin allow-list parsing in the parser module so config-contract extraction"
- `packages/remnic-core/src/config-security.ts:141` — "// Precedence: operator-authored config, then the environment, then a host-materialized schema default."
- `packages/remnic-core/src/config.test.ts:9` — "/** * Run `body` with XDG_CONFIG_HOME pointing at a throwaway dir so the * sticky-legacy `emitLegacyTools` default (#155"
- `packages/remnic-core/src/config.test.ts:137` — "// A host that materializes the manifest default into cfg while the"
- `packages/remnic-core/src/config.test.ts:138` — "// operator's raw config omits the key must not shadow the env override."
- `packages/remnic-core/src/config.test.ts:169` — "// Cursor Bugbot + chatgpt-codex-connector both flagged the same class: the"
- `packages/remnic-core/src/config.test.ts:170` — "// OpenClaw SDK materializes JSON-schema defaults into `api.pluginConfig`"
- `packages/remnic-core/src/config.test.ts:171` — "// BEFORE `parseConfig` runs, so a fresh install would arrive with"
- `packages/remnic-core/src/config.test.ts:172` — "// `emitLegacyTools: false` already populated even though the operator never"
- `packages/remnic-core/src/config.test.ts:173` — "// wrote the key. The original resolver treated any present value as"
- `packages/remnic-core/src/config.test.ts:174` — "// operator-set, which short-circuited the sticky-legacy fallback to"
- `packages/remnic-core/src/config.test.ts:175` — "// `hasLegacyConnectorEntries()` and broke upgrades with legacy connector"
- `packages/remnic-core/src/config.test.ts:176` — "// entries on disk. Fix: parseConfig now takes an optional `rawOperatorConfig`"
- `packages/remnic-core/src/config.test.ts:177` — "// argument (sourced from `loadPluginConfigFromFile`, the pre-defaults"
