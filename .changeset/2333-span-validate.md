---
"@remnic/core": patch
---

Add a span-offset validator. Empty spans and out-of-range offsets return `{ok:false}`. Non-integers throw. Extraction wiring is unchanged. Part of #2333.
