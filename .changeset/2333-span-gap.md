---
"@remnic/core": patch
---

Add a span-gap helper. Half-open `[start, end)` ranges return the distance between them. Overlap is 0. Inverted spans and non-integers throw. Extraction wiring is unchanged. Part of #2333.
