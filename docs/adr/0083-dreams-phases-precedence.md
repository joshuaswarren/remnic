# dreams.phases.* overrides win over legacy top-level lifecycle keys

Status: accepted

## Context
Lifecycle, REM-consolidation, and deep-sleep behavior was controlled by scattered top-level keys. The `dreams.phases.*` block groups them under one namespace, but runtime gates (the orchestrator's runLifecyclePolicyPass / runSemanticConsolidation, tier migration, the nightly-governance cron) still read the legacy fields, so a phases override that only updated the new object would be silently ignored - and `deepSleep.enabled=false` would be a contract lie while deep-sleep kept running.

## Decision
When a value is explicitly set under `dreams.phases.*`, it WINS over the corresponding legacy top-level key; legacy keys continue to be parsed so existing configs work unmodified. Precedence (highest to lowest): dreams.phases.lightSleep.enabled > lifecyclePolicyEnabled; dreams.phases.rem.enabled > semanticConsolidationEnabled; dreams.phases.deepSleep.enabled > (no legacy equivalent). The resolved phases decision is PROPAGATED into the legacy fields the runtime reads, not just stored on the dreamsPhases object. Derived values follow: semanticConsolidationIntervalHours derives from dreamsRem.cadenceMs (rounded up to the hour), explicit zero is preserved as the disable signal, and the runtime enabled flag is disabled alongside it so zero never means 'run every cycle'. Hot/cold tier migration and the nightly-governance cron are gated on deepSleep.enabled - when the phase is off, neither auto-registers. The `dreams.phases` namespace is intentionally different from the `dreaming` diary surface. Metrics mirror the RESOLVED lifecycle flag, not raw input.

## Consequences
Legacy top-level keys remain as fallbacks indefinitely; removing them breaks existing configs. Every new deep-sleep-adjacent scheduled activity must gate on the phase flag or it contradicts an explicit operator opt-out.

## Origin comments
- `packages/remnic-core/src/config.ts:897` — "// The `dreams.phases.*` block groups existing top-level lifecycle / REM /"
- `packages/remnic-core/src/config.ts:898` — "// deep-sleep gates under a unified namespace. When a value is explicitly"
- `packages/remnic-core/src/config.ts:899` — "// set under `dreams.phases.*`, it WINS over the corresponding legacy"
- `packages/remnic-core/src/config.ts:900` — "// top-level key. Legacy top-level keys continue to be parsed so existing"
- `packages/remnic-core/src/config.ts:901` — "// configs work without modification."
- `packages/remnic-core/src/config.ts:903` — "// Precedence summary (highest → lowest):"
- `packages/remnic-core/src/config.ts:904` — "// dreams.phases.lightSleep.enabled > lifecyclePolicyEnabled"
- `packages/remnic-core/src/config.ts:905` — "// dreams.phases.rem.enabled > semanticConsolidationEnabled"
- `packages/remnic-core/src/config.ts:906` — "// dreams.phases.deepSleep.enabled > (no legacy top-level equivalent)"
- `packages/remnic-core/src/config.ts:908` — "// This block is intentionally a DIFFERENT namespace from `dreaming`"
- `packages/remnic-core/src/config.ts:909` — "// (the diary surface — `surfaces/dreams.ts`). See docs/dreams.md."
- `packages/remnic-core/src/config.ts:931` — "// Resolve legacy top-level defaults that the phases mirror. We compute them"
- `packages/remnic-core/src/config.ts:932` — "// here (before the return statement) so the phase parser can apply precedence"
- `packages/remnic-core/src/config.ts:933` — "// without duplicating the clamping logic."
- `packages/remnic-core/src/config.ts:1660` — "// Issue #678 PR 2/4: gate hot/cold tier migration (a deep-sleep activity)"
- `packages/remnic-core/src/config.ts:1661` — "// on dreams.phases.deepSleep.enabled. When deep sleep is disabled,"
- `packages/remnic-core/src/config.ts:1662` — "// tier migration is forced off regardless of legacy flag."
- `packages/remnic-core/src/config.ts:2362` — "// Codex P1 on PR 763 round 2: gate the nightly-governance cron"
- `packages/remnic-core/src/config.ts:2363` — "// (deep-sleep's primary scheduled execution path) on"
- `packages/remnic-core/src/config.ts:2364` — "// dreams.phases.deepSleep.enabled. When the phase is disabled the"
- `packages/remnic-core/src/config.ts:2365` — "// cron must NOT auto-register, otherwise `deepSleep.enabled=false`"
- `packages/remnic-core/src/config.ts:2366` — "// is a contract lie — deep-sleep keeps running."
- `packages/remnic-core/src/config.ts:2487` — "// Issue #678 PR 2/4: when `dreams.phases.rem.*` is set, the resolved"
- `packages/remnic-core/src/config.ts:2488` — "// dreamsPhases value WINS over the legacy top-level key. The runtime"
- `packages/remnic-core/src/config.ts:2489` — "// gates (orchestrator's `runSemanticConsolidation`) read these legacy"
- `packages/remnic-core/src/config.ts:2490` — "// fields, so we must propagate the precedence here, not just in the"
- `packages/remnic-core/src/config.ts:2491` — "// `dreamsPhases` object."
- `packages/remnic-core/src/config.ts:2504` — "// semanticConsolidationIntervalHours is derived from dreamsRem.cadenceMs"
- `packages/remnic-core/src/config.ts:2505` — "// when an override is set (rounded up to the nearest hour). Preserve"
- `packages/remnic-core/src/config.ts:2506` — "// explicit zero so legacy schedulers see the same disable-by-zero signal"
- `packages/remnic-core/src/config.ts:2507` — "// as the dreams.phases.rem config; the runtime enabled flag is also"
- `packages/remnic-core/src/config.ts:2508` — "// disabled above so zero does not mean "run every maintenance cycle"."
- `packages/remnic-core/src/config.ts:2797` — "// Issue #678 PR 2/4: dreams.phases.rem.minIntervalMs WINS when set."
- `packages/remnic-core/src/config.ts:3226` — "// Issue #678 PR 2/4: dreams.phases.lightSleep.* WINS over legacy keys."
- `packages/remnic-core/src/config.ts:3227` — "// The runtime gate (orchestrator's `runLifecyclePolicyPass`) reads"
- `packages/remnic-core/src/config.ts:3228` — "// these legacy fields, so propagate the precedence here."
- `packages/remnic-core/src/config.ts:3244` — "// Issue #678 PR 2/4: mirror the resolved dreams light-sleep enabled flag"
- `packages/remnic-core/src/config.ts:3245` — "// (which already incorporates dreams.phases precedence + legacy fallback)."
- `packages/remnic-core/src/config.ts:4032` — "// Page-level versioning (issue #371). Issue #678 PR 2/4:"
- `packages/remnic-core/src/config.ts:4033` — "// dreams.phases.deepSleep.* WINS over legacy keys."
