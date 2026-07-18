---
name: remnic-comparator-total-order
description: "Sort comparators must return 0 for equal keys; a bare two-arm ternary comparator is never total"
astCondition:
  - '($A, $B) => $X < $Y ? 1 : -1'
  - '($A, $B) => $X < $Y ? -1 : 1'
  - '($A, $B) => $X > $Y ? 1 : -1'
  - '($A, $B) => $X > $Y ? -1 : 1'
  - '($A, $B) => ($X < $Y ? 1 : -1)'
  - '($A, $B) => ($X < $Y ? -1 : 1)'
  - '($A, $B) => ($X > $Y ? 1 : -1)'
  - '($A, $B) => ($X > $Y ? -1 : 1)'
globs:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.mts"
---

You are writing a comparator whose entire body is a two-arm ternary
(`a.x < b.x ? -1 : 1`). It never returns `0` for equal keys, so equal
items claim both `a > b` and `b > a` — order becomes non-deterministic
across runs, which breaks byte-stable outputs, top-N slices, briefings,
and diffs. AI reviewers flagged this exact shape in at least five
separate Remnic PRs (AGENTS.md pattern 12).

Write a total comparator instead:

- Guard equality first: `if (a.x !== b.x) return a.x < b.x ? -1 : 1; return 0;`
  (or fall through to a stable secondary key such as `id`).
- For numbers, prefer `a.x - b.x`.
- Never let both orderings of equal items return the same sign.

Add a test that sorts a list containing duplicate keys and asserts the
output is identical across invocations.
