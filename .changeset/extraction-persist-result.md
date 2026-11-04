---
"@remnic/core": patch
---

Stability: stable

`persistExtraction` returns this run's judge-deferred count and pending_review ids instead of writing side-channel fields on the orchestrator, and `appendPersistedThreadEpisodes` takes the pending_review ids it excludes — per-run results so independent sessions cannot read each other's retention decisions (preparation for issue #1526's bounded-parallel extraction queue). No behavior change at the default serial concurrency.
