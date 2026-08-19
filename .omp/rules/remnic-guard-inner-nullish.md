---
name: remnic-guard-inner-nullish
description: "Array.isArray on nested elements silently treats inner null/undefined as non-empty"
condition:
  - '\.every\(\([^)]*\)\s*=>\s*Array\.isArray\([^)]*\)\s*&&\s*[^)]*\.length\s*===\s*0'
globs:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
interruptMode: never
---

`batches.every((b) => Array.isArray(b) && b.length === 0)` classifies
`[null]` and `[undefined]` as NOT empty, because `Array.isArray(null)` is
`false`. When the same function already treats a top-level `null` as empty,
the two halves disagree: `null` → `true`, `[null]` → `false`.

Decide the nested contract explicitly and test it:

```ts
return batches.every(
  (batch) => batch == null || (Array.isArray(batch) && batch.length === 0),
);
```

Observed on `isEmptyAnalysisBatches` (PR #2716): top-level nullish was
empty while inner nullish was not, so a batch list of absent windows read
as populated. Add cases for `[null]`, `[undefined]`, and a mixed
`[null, []]` whenever a guard walks nested collections.
