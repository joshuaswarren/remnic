# Leaf-key guard scans are unambiguous per manifest and keyed by documented path

Status: accepted

## Context
Zero-disable documentation is scanned by leaf key so unrelated entries sharing a name cannot be confused. A schema *description* documents only the entry at its own path; leaves recur across manifests (root, plugin, and shim all carry `cap`), so global leaf counting would reject valid source-JSDoc docs.

## Decision
Leaves documented via source JSDoc are real top-level config field names; a schema description documents only its own path and must not vouch for an unrelated top-level entry sharing the leaf. A schema description contributes its leaf to the leaf-keyed guard scan only when the leaf is unambiguously zero-disable within that manifest — another numeric or combinator entry sharing the leaf without the zero-disable contract excludes the leaf from the scan (schema-min still keys by full dotted path, so nested docs remain checked there). Leaf uniqueness is per-manifest: the same leaf in each of several manifests is still unambiguous within each. An entry is zero-disable via its own schema description at any depth, or via a top-level leaf documented in source JSDoc — never via a nested leaf coinciding with an unrelated top-level name.

## Consequences
Leaves with mixed contracts are dropped from the leaf-keyed scan rather than poisoning unrelated fields' consumer scans; nested-only coverage relies on the dotted-path schema-min check.

## Origin comments
- `scripts/config-contract/disable-value-check.ts:921` — "Leaves documented via source JSDoc are real top-level config field names; a"
- `scripts/config-contract/disable-value-check.ts:922` — "schema *description* documents only the entry at its own path, so it must"
- `scripts/config-contract/disable-value-check.ts:923` — "not vouch for an unrelated top-level entry sharing the leaf."
- `scripts/config-contract/disable-value-check.ts:933` — "A schema *description* contributes its leaf to the leaf-keyed guard scan only"
- `scripts/config-contract/disable-value-check.ts:934` — "when the leaf is unambiguously zero-disable: another numeric (or combinator)"
- `scripts/config-contract/disable-value-check.ts:935` — "entry sharing the leaf without the zero-disable contract would poison that"
- `scripts/config-contract/disable-value-check.ts:936` — "unrelated field's consumer scan, so such a leaf is left out (schema-min still"
- `scripts/config-contract/disable-value-check.ts:937` — "keys by full dotted path, so nested docs are still checked there)."
- `scripts/config-contract/disable-value-check.ts:939` — "Leaf uniqueness is per-manifest: the same leaf appearing once in each of"
- `scripts/config-contract/disable-value-check.ts:940` — "several manifests is still unambiguous within each manifest. A global"
- `scripts/config-contract/disable-value-check.ts:941` — "count would falsely reject source-JSDoc docs when manifests duplicate"
- `scripts/config-contract/disable-value-check.ts:942` — "a leaf (root + plugin + shim all carry `cap`)."
- `scripts/config-contract/disable-value-check.ts:964` — "schema-min over every flattened entry (nested blocks included). An entry is"
- `scripts/config-contract/disable-value-check.ts:965` — "zero-disable via its own schema description at any depth, or via a top-level"
- `scripts/config-contract/disable-value-check.ts:966` — "leaf documented in a source JSDoc — never a nested leaf coinciding with an"
- `scripts/config-contract/disable-value-check.ts:967` — "unrelated top-level name."
- `scripts/config-contract/disable-value-check.ts:913` — "Pure core: given source texts and manifest property maps, return every §33 violation (unsorted). No filesystem,..."
