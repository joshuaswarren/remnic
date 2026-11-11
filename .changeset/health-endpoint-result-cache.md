---
"@remnic/core": patch
---

Cache healthy per-namespace search health results for 10 seconds inside NamespaceSearchRouter. Repeated GET /engram/v1/health and doctor probes reuse the last healthy snapshot instead of re-creating and re-probing a temporary QMD backend on every call. A snapshot is healthy when the backend is available, the collection state is neither missing nor unknown, the embedding backlog is at or under `qmdEmbeddingBacklogThreshold`, and backlog data is present when the backend reports status. Anything else, and every aborted or thrown probe, is never cached, so readiness polls see recovery on the next call. `isSearchHealthDegraded` is now the single definition of a degraded answer, shared by the readiness report and the cache. clearCache, dispose, and disableSearchBackends drop the cache so later health answers stay honest.

Stability: stable
