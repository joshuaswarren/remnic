---
"@remnic/core": patch
---

Extraction persistence now runs batch-end finalization when any branch throws after an earlier fact in the batch is durable. Previously a failure in the chunked-parent post-write steps, the semantic-merge post effects, the profile append, or the question write skipped the content-hash flush, behavior signals, harmonic construction, temporal/tag index update, and QMD request for the facts already written. A retry exact-dedupes those facts, so their effects were never queued again. One boundary around each persist pass now finalizes the committed writes before rethrowing the original error, and finalization runs at most once per pass. Fixes #3288.

Stability: stable
