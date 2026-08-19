---
"@remnic/core": patch
---

Add a persist seam for merge-on-write. Disabled or `mergeMin=0` writes a new fact. A merge updates the existing id. `extraction-persist` is not wired yet. Part of #2330.
