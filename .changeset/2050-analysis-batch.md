---
"@remnic/core": patch
---

Add a bounded overlapping observation batcher for timeline analysis. `maxBatch` 0 returns no batches. Negative overlap and overlap that meets or exceeds `maxBatch` are rejected. Observations sort by capture time then id. Part of #2050.
