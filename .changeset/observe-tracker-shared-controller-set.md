---
"@remnic/core": patch
Stability: stable
---

PendingObserveExtractionTracker stopped copying every prior controller into a fresh `Set` per tracked extraction: overlapping queued observe extractions on one key now share one per-key controller set, so retained memory for N stalled tracks is linear instead of quadratic (~543MB at 6000 overlapping tracks before, ~6.4MB after, measured with forced GC). `cancel`/`abortTracked` semantics are unchanged — every controller ever tracked for a key is still aborted — and an abort listener that reentrantly tracks a new extraction is not aborted by the in-flight cancel pass (abort iteration snapshots the set first). Closes #3327.
