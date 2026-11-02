---
"@remnic/core": patch
---

Propagate entity persistence failures so extraction retains source turns and does not mark failed input processed. On partial success (durable facts already written), run the shared batch-end finalization before rethrow — content-hash flush, behavior signals, harmonic construction, temporal/tag indexes — and schedule QMD reindex. Preserve the original entity error if best-effort maintenance fails. Fixes #3228. Fixes #3231.

Stability: stable
