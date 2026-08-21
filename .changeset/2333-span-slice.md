---
"@remnic/core": patch
---

Add a span-text slicer. Half-open `[start, end)` returns the source slice. Empty spans return `""`. Out-of-range offsets and non-integers throw. Extraction wiring is unchanged. Part of #2333.
