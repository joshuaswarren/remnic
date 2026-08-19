---
"@remnic/core": patch
---

Add `parseMaxBatch` to the activity timeline layer. `0` is allowed (empty batches). Negative or non-integer values throw. Finite integer ≥ 0 is returned. Part of #2050.
