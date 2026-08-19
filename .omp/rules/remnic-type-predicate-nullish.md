---
name: remnic-type-predicate-nullish
description: "A type predicate that returns true for null/undefined must include them in the narrowed type"
condition:
  - '\):\s*\w+\s+is\s+readonly\s*\[\]\s*\{'
globs:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
interruptMode: never
---

A guard written as `function isEmptyX(v: unknown): v is readonly []` that
also returns `true` for `null` and `undefined` narrows the true-branch to
an array type the value may not have. Callers then read `.length` or index
into a nullish value with no compile error.

Either:

- widen the predicate to the shapes the function actually accepts —
  `v is null | undefined | readonly []`, or
- return plain `boolean` when the narrowing buys nothing.

Observed on `isEmptyDeepRecallTrace` (PR #2714, flagged Major): the body
returned `true` for `trace == null` while the signature promised
`readonly []`. The same shape recurs across the `isEmpty*` guard family, so
check the nullish branch every time you write `X is <arrayType>`.
