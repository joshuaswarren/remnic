---
"@remnic/core": patch
---

Stability: stable

Serialize fact writes under the fact-dedup commit window more safely: publish the fact-hash index before the window releases (peer processes can no longer miss a just-committed write's hash), finalize deferred side effects when the fail-closed window throws, and backfill bi-temporal bounds onto the copy a raced duplicate lost to. Provider-breaker ownership tightened: only the half-open probe owner's failure may re-open past the threshold, and an unowned success no longer settles another attempt's probe. Manifests now schema-validate `extractionQueueConcurrency` as a positive integer.
