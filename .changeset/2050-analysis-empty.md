---
"@remnic/core": patch
---

Add `isEmptyObservationSet` to the activity timeline layer. `null`, `undefined`, and `[]` are empty. A non-array throws. Part of #2050.
