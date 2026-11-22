# Procedural recall ships enabled by default with safer floors; the conservative preset stays opt-out

Status: accepted

## Context
Procedural recall was gated behind `procedural.enabled === true` on raw config, so an omitted key left the section disabled even though parseConfig reported enabled:true - the flag and the pipeline disagreed. Flipping the default on without adjusting thresholds would surface low-precision mined procedures to every install, and the `conservative` preset (whose intent is minimal proactive behavior) would have been silently opted in.

## Decision
`procedural.enabled` defaults to true when the key is omitted; the recall-pipeline gate must read the RESOLVED value, never raw config. Enabling by default is paired with safer floors: a stricter promotion success rate (0.75), a shorter lookback (14 days), and a lower recall cap (2). The `conservative` preset intentionally keeps procedural memory OFF; a preset pins a subset of keys and the `procedural` block is deep-merged, so a user-provided partial block (e.g. only minOccurrences) must NOT clobber the preset's `enabled: false`. A preset is a default, not a ceiling: users opt back in by setting the key explicitly. Only a coerced `=== true` or the omitted-key path enables the section; unrecognized values are rejected upstream and, defensively, leave the section disabled.

## Consequences
Users upgrading from default-off get the feature automatically. The conservative preset requires an explicit `procedural.enabled: true`. Partial preset overrides preserve the opt-out, so preset handling must stay a deep merge, not a shallow spread.

## Origin comments
- `packages/remnic-core/src/config.test.ts:1396` — "// When the user does not override procedural thresholds, the defaults"
- `packages/remnic-core/src/config.test.ts:1397` — "// MUST match the safer floor committed in #567 PR 3. This test locks in"
- `packages/remnic-core/src/config.test.ts:1399` — "// Slice 4 flips `enabled` to true — asserted in the next test."
- `packages/remnic-core/src/config.test.ts:1409` — "// Codex P2 on #609: the master gate defaulting to `true` must also flip"
- `packages/remnic-core/src/config.test.ts:1410` — "// the default recall pipeline to include the `procedure-recall` section."
- `packages/remnic-core/src/config.test.ts:1411` — "// Previously the pipeline check required `cfg.procedural?.enabled === true`"
- `packages/remnic-core/src/config.test.ts:1412` — "// on raw config, so an omitted key left the section disabled even"
- `packages/remnic-core/src/config.test.ts:1413` — "// though `parseConfig` reported enabled:true."
- `packages/remnic-core/src/config.test.ts:1439` — "// `procedural: false` or `procedural: null` would previously normalize"
- `packages/remnic-core/src/config.test.ts:1440` — "// to `{}` and then the omitted-key branch would silently enable the"
- `packages/remnic-core/src/config.test.ts:1441` — "// feature — the opposite of the user's shorthand intent. Reject loudly."
- `packages/remnic-core/src/config.test.ts:1459` — "// Cursor Medium on #609: the `conservative` preset disables many"
- `packages/remnic-core/src/config.test.ts:1460` — "// features; the default flip must not silently opt it into procedural"
- `packages/remnic-core/src/config.test.ts:1461` — "// memory."
- `packages/remnic-core/src/config.test.ts:1468` — "// A user can still opt back in by setting the key explicitly — the"
- `packages/remnic-core/src/config.test.ts:1469` — "// preset is a default, not a ceiling."
- `packages/remnic-core/src/config.test.ts:1477` — "// Codex P1 on #609: a user-provided `procedural` block that does NOT"
- `packages/remnic-core/src/config.test.ts:1478` — "// set `enabled` must not clobber the preset's `enabled: false`. The"
- `packages/remnic-core/src/config.test.ts:1479` — "// preset's procedural object is deep-merged with the baseCfg's"
- `packages/remnic-core/src/config.test.ts:1480` — "// procedural object so partial overrides (minOccurrences, lookbackDays)"
- `packages/remnic-core/src/config.test.ts:1481` — "// preserve the opt-out."
- `packages/remnic-core/src/config.test.ts:1496` — "// Omitting `procedural.enabled` ships the feature ON. Users who were"
- `packages/remnic-core/src/config.test.ts:1497` — "// previously on the default-off branch get the new default automatically."
- `packages/remnic-core/src/config.test.ts:2669` — "// Enabled by default — the projection must stay fresh without operator action,"
- `packages/remnic-core/src/config.test.ts:2670` — "// mirroring lifecycle-ledger auto-compaction's enabled-by-default posture."
- `packages/remnic-core/src/config.ts:635` — "// Issue #567 PR 4/5 flipped `procedural.enabled` default to `true`."
- `packages/remnic-core/src/config.ts:636` — "// The conservative preset intentionally keeps the feature OFF to"
- `packages/remnic-core/src/config.ts:637` — "// match its restrictive intent (no proactive extraction, no"
- `packages/remnic-core/src/config.ts:638` — "// compression guideline learning, etc.). Users who want procedural"
- `packages/remnic-core/src/config.ts:639` — "// memory on a conservative preset must set `procedural.enabled: true`"
- `packages/remnic-core/src/config.ts:640` — "// explicitly."
- `packages/remnic-core/src/config.ts:740` — "// Deep-merge the `procedural` block specifically: the preset may pin a"
- `packages/remnic-core/src/config.ts:741` — "// subset of keys (e.g. `conservative` pins `procedural: { enabled: false }`),"
- `packages/remnic-core/src/config.ts:742` — "// and a user-provided `procedural` block with just `minOccurrences` or"
- `packages/remnic-core/src/config.ts:743` — "// `lookbackDays` must NOT silently discard the preset's `enabled: false`."
- `packages/remnic-core/src/config.ts:744` — "// CLAUDE.md rule 22 (dedup config resolution) + Codex P1 on #609."
- `packages/remnic-core/src/config.ts:1122` — "// Safer-by-default floor (issue #567 PR 3/5): raise from 0.7 to 0.75."
- `packages/remnic-core/src/config.ts:1123` — "// Miner promotion now requires a stricter trajectory success rate before"
- `packages/remnic-core/src/config.ts:1124` — "// procedures become candidates, reducing false positives when procedural"
- `packages/remnic-core/src/config.ts:1125` — "// recall is enabled by default in slice 4."
- `packages/remnic-core/src/config.ts:1140` — "// Safer-by-default lookback (issue #567 PR 3/5): lower from 30 to 14 days."
- `packages/remnic-core/src/config.ts:1141` — "// Shorter window keeps mined procedures more recent, which improves"
- `packages/remnic-core/src/config.ts:1142` — "// relevance once recall is on by default."
- `packages/remnic-core/src/config.ts:1148` — "// Safer-by-default recall cap (issue #567 PR 3/5): lower from 3 to 2."
- `packages/remnic-core/src/config.ts:1149` — "// Cap the injected procedure block so enabling procedural recall by"
- `packages/remnic-core/src/config.ts:1150` — "// default does not crowd out other recall sections."
- `packages/remnic-core/src/config.ts:4358` — "// Default-on since issue #567 PR 4/5: the master `procedural.enabled`"
- `packages/remnic-core/src/config.ts:4359` — "// gate now defaults to `true` when the key is omitted, so the recall"
- `packages/remnic-core/src/config.ts:4360` — "// pipeline must stay in sync. Explicit `false` (or any coerceBool"
- `packages/remnic-core/src/config.ts:4361` — "// falsy variant) still disables recall injection."
- `packages/remnic-core/src/config.ts:4363` — "// CLAUDE.md rule 48 (least-privileged defaults) + Cursor review on #609:"
- `packages/remnic-core/src/config.ts:4364` — "// never fail open on unrecognized values. Only `coerced === true` or"
- `packages/remnic-core/src/config.ts:4365` — "// the "key omitted" path enables the section. `parseConfig` throws"
- `packages/remnic-core/src/config.ts:4366` — "// on invalid values upstream, so this branch only ever sees boolean"
- `packages/remnic-core/src/config.ts:4367` — "// results — `coerced === undefined` should never happen in practice,"
- `packages/remnic-core/src/config.ts:4368` — "// but defense-in-depth keeps the section disabled if it ever does."
