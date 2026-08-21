---
"@remnic/core": patch
---

Address two Codex review findings on the wearable cross-source fusion (PR #1849 / issue #1810): (1) `fuseDay` now calls `assertEnabled()` — the same master-gate check the sync/check paths use — before the fusion-specific enabled check, so a globally-disabled wearables setup can no longer read sources or write/delete `_fusion/<date>.md` artifacts; (2) the fusion algorithm/schema version (`FUSION_ALGO_VERSION`) is folded into the day content hash (idempotency key) so a change to the clustering/reconciliation/reconstruction algorithm invalidates cached artifacts even when raw inputs and fusion config are byte-identical — pre-existing `_fusion/` files are regenerated rather than served stale.
