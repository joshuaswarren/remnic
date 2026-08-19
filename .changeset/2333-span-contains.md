---
"@remnic/core": patch
---

Add a span-contains helper. Half-open `[start, end)` includes `start` and excludes `end`. Inverted spans and non-integers throw. Extraction wiring is unchanged. Part of #2333.
