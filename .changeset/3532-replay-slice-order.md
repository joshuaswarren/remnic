---
"@remnic/core": patch
---

Stability: stable

Submit `ingestReplayBatch` source-valid_at slices to the extraction queue one at a time, in sorted order, instead of firing them concurrently. Under bounded queue concurrency (#3532) slices from different sessions ran in parallel and a later-dated slice could extract before an earlier one that stalled mid-flight; serialized submission keeps the global source order as the execution order, matching the `ingestBulkImportBatch` slice loop.
