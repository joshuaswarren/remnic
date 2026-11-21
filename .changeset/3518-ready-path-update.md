---
"@remnic/core": patch
"@remnic/server": patch
Stability: stable
---

Move the corpus-wide QMD update out of the awaited startup-ready path so the ready mark no longer waits on a full reindex.

`deferredInitialize` no longer runs the namespace/corpus update: the probe and collection ensure already happen in `initialize()`, and the ready mark now waits only on those plus the model warm-up. The update runs after ready under the existing server retry loop, which stays armed because `deferredSyncSucceeded` remains false until `startupSearchSync` actually completes — preserving the failure and incomplete-discovery semantics.

`startupSearchSync` is split into a shared ensure core (probe, catalog-union collection ensure, missing-collection noop swap) exposed as the new `startupSearchReadySync`, with the corpus update and warm-up layered on top. The server warm-up gate calls the readiness level so warm-up attempts never block on a reindex; the retry loop keeps the full sync.

The QMD index lands atomically, so recall serves the previous index until the post-ready update commits instead of holding readiness for the reindex duration.
