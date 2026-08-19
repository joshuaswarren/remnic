---
"@remnic/core": patch
---

Add `parseOverlap` to the activity timeline layer. `0` is allowed. Negative or non-integer values throw. When `maxBatch > 0`, overlap must be less than `maxBatch`. Part of #2050.
