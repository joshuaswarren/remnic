---
"@remnic/core": patch
---

Add a span-join helper. Adjacent half-open `[start, end)` spans merge. A gap or overlap returns `not_adjacent`. Inverted spans and non-integers throw. Extraction wiring is unchanged. Part of #2333.
