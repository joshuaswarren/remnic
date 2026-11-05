---
"@remnic/core": patch
---

Cut per-observe retention churn in the extraction hot paths: the buffer-drain claim merge is O(n+m) via canonical turn identity keys instead of pairwise comparison, the extraction queue coalesces a newer enqueue over a queued-not-started task for the same key instead of stacking another turn-snapshot closure, `recordTurnUnlocked` builds its prior/snapshot arrays only for decision paths that read them (steady-state buffering copies nothing), and the pending-observe extraction tracker removes its entry on any settle so a failed extraction can no longer wedge the key and retain every registered abort controller.

Stability: stable
