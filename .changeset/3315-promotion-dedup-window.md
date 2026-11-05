---
"@remnic/core": patch
---

Stability: stable

Serialize promotion-destination writes under the fact-dedup commit window: with `extractionQueueConcurrency > 1`, concurrent equal-content promotions into the same shared/profile namespace can no longer both persist — the second promotion is suppressed in-window with temporal-bound backfill onto the surviving copy, while unique promotions keep the authoritative hash-miss fast path.
