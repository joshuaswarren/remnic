# Feature gates resolve once per operation into frozen CapabilitySets that project 1:1 from config flags

Status: accepted

## Context
Feature gates were previously read as scattered `this.config.<flag>Enabled` checks at dozens of call sites, so behavior depended on when and where a gate was read (#1523, #1566). Some optional flags carried asymmetric defaults at call sites (`!== false` default-on vs `=== true` default-off), which a naive centralization silently changed.

## Decision
Resolve feature gates exactly once at operation entry into a frozen, readonly-boolean CapabilitySet and thread the resolved result down; never re-resolve mid-operation, and never read raw config flags at gate sites. (1) Every CapabilitySet field projects from exactly one `<field>Enabled` config flag — the mapping is explicit (not string-derived) and parity-tested: a caps-resolved run and a config-derived run must produce identical booleans for every gate, on AND off, across representative flag combinations including all-off, all-on, and the optional-flag edge cases; (2) optional graph flags keep their exact call-site default semantics — graphAssistInFullMode and graphWriteSessionAdjacency default ON (`!== false`), graphExpandedIntent defaults OFF (`=== true`); explicit-false must propagate and not be swallowed by the default; (3) resolution is deterministic: same config, same values, so there is never a reason to re-resolve; both resolved sets are frozen because a mid-operation mutation would break the once-per-op contract; (4) TrustScore subsumes the Memory Worth multiplier when both are enabled — the CapabilitySet encodes that mutual exclusion; (5) CapabilitySets exist per cluster (recall-operation, graph-construction, access-setup, memory-lifecycle, indexing, creation, namespace, QMD, identity-continuity, local-LLM, security trust-zone, eval, utility-learning, objective-state, compression, output formatting, consolidation, extraction details, recall-enhancement, pipeline-processing, conversation) with defaults resolved at the parse boundary so projections are pure passthroughs of required booleans.

## Consequences
Adding a feature flag now requires touching the CapabilitySet and its parity test — the loud-fail design intentionally makes drift a test failure. Callers cannot flip a gate mid-operation by mutating config; a config change takes effect on the next operation. The parity suite tests representative combinations rather than the full 2^n space, so an interaction unique to one untested combination could in principle slip through.

## Origin comments
### capabilities-gate-parity-contract
- `packages/remnic-core/src/capabilities-cluster-b.test.ts:10` — "/** * Parity tests for the access-setup capability set (issue #1566 Cluster B). * * Every access-setup capability field "
- `packages/remnic-core/src/capabilities.test.ts:42` — "/** * Characterization tests for the recall-operation CapabilitySet (issue #1523). * * These guard against composition d"
- `packages/remnic-core/src/capabilities.test.ts:51` — "/** * Map of CapabilitySet field → the PluginConfig flag it projects from. * Kept explicit (rather than derived by strin"
- `packages/remnic-core/src/capabilities.test.ts:170` — "// Same invariant as the recall CapabilitySet tests above: every caps field"
- `packages/remnic-core/src/capabilities.test.ts:171` — "// must project from its `<field>Enabled` config flag, so a future edit to"
- `packages/remnic-core/src/capabilities.test.ts:172` — "// `resolveGraphConstructionCapabilities` that maps a field to the wrong flag"
- `packages/remnic-core/src/capabilities.test.ts:173` — "// (or drops the `!== false` default for the optional session-adjacency flag)"
- `packages/remnic-core/src/capabilities.test.ts:174` — "// fails loudly here."
- `packages/remnic-core/src/capabilities.test.ts:176` — "// Parity contract: a caps-resolved run and a config-derived run MUST produce"
- `packages/remnic-core/src/capabilities.test.ts:177` — "// identical boolean values for every gate — on AND off. These tests are the"
- `packages/remnic-core/src/capabilities.test.ts:178` — "// executable proof of that contract."
- `packages/remnic-core/src/capabilities.test.ts:272` — "// This is the core parity test: for EVERY combination of the 5 cluster-A"
- `packages/remnic-core/src/capabilities.test.ts:273` — "// flags, the caps-resolved values MUST be identical to what the old"
- `packages/remnic-core/src/capabilities.test.ts:274` — "// scattered `this.config.<flag>Enabled` reads would have produced."
- `packages/remnic-core/src/capabilities.test.ts:275` — "//"
- `packages/remnic-core/src/capabilities.test.ts:276` — "// We exercise representative combinations rather than the full 2^5 space"
- `packages/remnic-core/src/capabilities.test.ts:277` — "// (32 cases) to keep the test cheap, but we cover:"
- `packages/remnic-core/src/capabilities.test.ts:278` — "// - all-off (the "no graphs" baseline)"
- `packages/remnic-core/src/capabilities.test.ts:279` — "// - all-on (the "full graph" mode)"
- `packages/remnic-core/src/capabilities.test.ts:280` — "// - only entity graph"
- `packages/remnic-core/src/capabilities.test.ts:281` — "// - multiGraph off but others on (the recall-without-write split)"
- `packages/remnic-core/src/capabilities.test.ts:282` — "// - session-adjacency undefined vs explicit-false"
- `packages/remnic-core/src/capabilities.test.ts:350` — "// Same invariant as the sets above: every caps field must project from its"
- `packages/remnic-core/src/capabilities.test.ts:351` — "// `<field>Enabled` config flag, so a future edit that maps a field to the wrong"
- `packages/remnic-core/src/capabilities.test.ts:352` — "// flag fails loudly here. All ten flags are required booleans on PluginConfig"
- `packages/remnic-core/src/capabilities.test.ts:353` — "// (defaults resolved at the parse boundary), so the projection is a pure"
- `packages/remnic-core/src/capabilities.test.ts:354` — "// passthrough — no optional-default variants needed."
- `packages/remnic-core/src/capabilities.test.ts:357` — "// identical boolean values for every gate — on AND off."
- `packages/remnic-core/src/capabilities.test.ts:421` — "// For representative on/off combinations, the caps-resolved values MUST be"
- `packages/remnic-core/src/capabilities.test.ts:422` — "// identical to what the old scattered `this.config.<flag>Enabled` reads"
- `packages/remnic-core/src/capabilities.test.ts:423` — "// produced. All ten flags used bare reads (no `!== false`/`=== true` at the"
- `packages/remnic-core/src/capabilities.test.ts:424` — "// call site that would change the value — the two sites that wrote"
- `packages/remnic-core/src/capabilities.test.ts:425` — "// `=== true` were redundant coercion on an already-boolean config field),"
- `packages/remnic-core/src/capabilities.test.ts:426` — "// so parity is a direct equality against the resolved config boolean."
- `packages/remnic-core/src/capabilities.test.ts:502` — "// `<field>Enabled` config flag. All two flags are required booleans on"
- `packages/remnic-core/src/capabilities.test.ts:503` — "// PluginConfig (defaults resolved at the parse boundary), so the projection"
- `packages/remnic-core/src/capabilities.test.ts:504` — "// is a pure passthrough."
- `packages/remnic-core/src/capabilities.test.ts:685` — "// Guard: resolveNamespaceCapabilities(config).namespaces must always equal"
- `packages/remnic-core/src/capabilities.test.ts:686` — "// config.namespacesEnabled. The flag is a non-optional boolean so no default"
- `packages/remnic-core/src/capabilities.test.ts:687` — "// coercion is needed."
- `packages/remnic-core/src/capabilities.test.ts:716` — "// Same invariant: every caps field must project from its `<field>Enabled`"
- `packages/remnic-core/src/capabilities.test.ts:717` — "// config flag. All twelve flags are required booleans on PluginConfig (defaults"
- `packages/remnic-core/src/capabilities.test.ts:718` — "// resolved at the parse boundary), so the projection is pure passthrough."

### capabilities-graph-flag-asymmetric-defaults
- `packages/remnic-core/src/capabilities.test.ts:103` — "// The two optional graph flags carry default-when-undefined semantics, but"
- `packages/remnic-core/src/capabilities.test.ts:104` — "// when explicitly set to a concrete boolean the projection must match it."
- `packages/remnic-core/src/capabilities.test.ts:115` — "// parseConfig with no overrides exercises the documented defaults. The two"
- `packages/remnic-core/src/capabilities.test.ts:116` — "// optional graph flags encode asymmetric defaults on purpose:"
- `packages/remnic-core/src/capabilities.test.ts:117` — "// graphAssistInFullModeEnabled → default-ON (`!== false`)"
- `packages/remnic-core/src/capabilities.test.ts:118` — "// graphExpandedIntentEnabled → default-OFF (`=== true`)"
- `packages/remnic-core/src/capabilities.test.ts:239` — "// graphWriteSessionAdjacencyEnabled is optional — `!== false` means"
- `packages/remnic-core/src/capabilities.test.ts:240` — "// default-ON. This is the exact semantics the migrated call site used"
- `packages/remnic-core/src/capabilities.test.ts:241` — "// (orchestrator.ts buildGraphEdge), and the parity test below verifies"
- `packages/remnic-core/src/capabilities.test.ts:242` — "// the caps resolver does not drift from it."
- `packages/remnic-core/src/capabilities.test.ts:257` — "// Explicit-false must propagate (not get swallowed by the default)."

### capabilities-resolve-once-per-operation
- `packages/remnic-core/src/capabilities.test.ts:140` — "// The one-resolution-per-op contract (issue #1523): resolve ONCE at the"
- `packages/remnic-core/src/capabilities.test.ts:141` — "// operation entry, thread the frozen result down. This test proves the"
- `packages/remnic-core/src/capabilities.test.ts:142` — "// resolution is deterministic — calling it twice with the same config"
- `packages/remnic-core/src/capabilities.test.ts:143` — "// produces identical values for every gate, so there is never a reason to"
- `packages/remnic-core/src/capabilities.test.ts:144` — "// re-resolve mid-operation."
- `packages/remnic-core/src/capabilities.test.ts:161` — "// Both must be frozen — a mid-operation mutation would break the contract."

### capability-set-resolved-once
- `packages/remnic-core/src/capabilities.ts:1` — "/** * CapabilitySet — recall-operation feature gates resolved once, then threaded. * * Issue #1523 (Phase 1 of"
- `packages/remnic-core/src/capabilities.ts:30` — "/** * Frozen projection of recall-operation feature gates. * * Every field is `readonly boolean`. The composit"
- `packages/remnic-core/src/capabilities.ts:108` — "// ---------------------------------------------------------------------------"
- `packages/remnic-core/src/capabilities.ts:119` — "/** * Frozen projection of graph-construction feature gates. * * Every field is `readonly boolean`. Compositio"
- `packages/remnic-core/src/capabilities.ts:177` — "/** * Frozen projection of access-setup feature gates (issue #1566 Cluster B). * * Every field is `readonly bo"
- `packages/remnic-core/src/capabilities.ts:227` — "/** * Frozen projection of memory-lifecycle feature gates (issue #1523 batch 3). * * Resolved once per write /"
- `packages/remnic-core/src/capabilities.ts:321` — "/** * Frozen projection of indexing feature gates (issue #1523 batch 4). * * Resolved once per recall / extrac"
- `packages/remnic-core/src/capabilities.ts:371` — "/** * Frozen projection of creation-memory feature gates (issue #1523 batch 4). * * Resolved once per creation"
- `packages/remnic-core/src/capabilities.ts:431` — "/** * Frozen projection of namespace feature gates (issue #1523 batch 5). * * Every field is `readonly boolean"
- `packages/remnic-core/src/capabilities.ts:473` — "/** * Frozen projection of QMD feature gates (issue #1523 batch 6). * * Every field is `readonly boolean`. Com"
- `packages/remnic-core/src/capabilities.ts:558` — "/** * Frozen projection of identity-continuity feature gates (issue #1523 batch 6). */"
- `packages/remnic-core/src/capabilities.ts:591` — "/** * Frozen projection of local-LLM feature gates (issue #1523 batch 6). */"
- `packages/remnic-core/src/capabilities.ts:624` — "/** * Frozen projection of security/trust-zone feature gates (issue #1523 batch 7). */"
- `packages/remnic-core/src/capabilities.ts:671` — "/** * Frozen projection of eval/benchmark feature gates (issue #1523 batch 7). */"
- `packages/remnic-core/src/capabilities.ts:716` — "/** * Frozen projection of utility-learning feature gates (issue #1523 batch 7). */"
- `packages/remnic-core/src/capabilities.ts:753` — "/** * Frozen projection of objective-state feature gates (issue #1523 batch 7). */"
- `packages/remnic-core/src/capabilities.ts:793` — "/** * Frozen projection of compression feature gates (issue #1523 batch 7). */"
- `packages/remnic-core/src/capabilities.ts:834` — "/** * Frozen projection of output formatting and presentation feature gates (issue #1523 batch 8). */"
- `packages/remnic-core/src/capabilities.ts:893` — "/** * Frozen projection of memory consolidation, compounding, and abstraction feature gates (issue #1523 batch"
- `packages/remnic-core/src/capabilities.ts:956` — "/** * Frozen projection of extraction pipeline details and auxiliary recall enrichment feature gates (issue #1"
- `packages/remnic-core/src/capabilities.ts:1039` — "/** * Frozen projection of recall-enhancement feature gates (issue #1523 batch 9). */"
- `packages/remnic-core/src/capabilities.ts:1139` — "/** * Frozen projection of pipeline-processing feature gates (issue #1523 batch 9). */"
- `packages/remnic-core/src/capabilities.ts:1238` — "/** * Frozen projection of conversation/context feature gates (issue #1523 batch 9). */"

### trustscore-memoryworth-mutual-exclusion
- `packages/remnic-core/src/capabilities.ts:88` — "// Issue #1577: TrustScore subsumes the Memory Worth multiplier when on;"

### optional-flag-default-semantics
- `packages/remnic-core/src/capabilities.ts:97` — "// Optional flags: preserve the exact default-when-undefined semantics the"
- `packages/remnic-core/src/capabilities.ts:163` — "// Optional flag: preserve the exact default-when-undefined semantics the"
- `packages/remnic-core/src/capabilities.ts:204` — "// Optional/default-off flag: preserve `=== true` semantics."
