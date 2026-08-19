---
"@remnic/core": patch
---

Add a span-overlap helper. Half-open `[start, end)` ranges that only touch at an endpoint do not overlap. Inverted spans and non-integers throw. Extraction wiring is unchanged. Part of #2333.
