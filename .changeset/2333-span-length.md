---
"@remnic/core": patch
---

Add a span-length helper. Half-open `[start, end)` is `end - start`. Empty spans return `0`. Inverted spans and non-integers throw. Extraction wiring is unchanged. Part of #2333.
