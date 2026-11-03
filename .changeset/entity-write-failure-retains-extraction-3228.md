---
"@remnic/core": patch
---

Propagate entity persistence failures so extraction retains source turns and does not mark failed input processed. On partial success, when an entity write or a fact's post-write step (contradiction resolve, anchor snapshot replace, embedding index, shared promotion, artifact write; graph-edge building is fail-open and does not rethrow) fails after earlier facts are durable, run the shared batch-end finalization before rethrow — content-hash flush, behavior signals, harmonic construction, temporal/tag indexes — and schedule QMD reindex. Preserve the original error if best-effort maintenance fails. Not covered: a throw from the durable fact write itself or from the semantic-merge and parent-write branches still skips finalization (tracked separately). Fixes #3228. Fixes #3231.

Stability: stable
