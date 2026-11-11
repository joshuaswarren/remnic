---
"@remnic/core": patch
---

Cache completed per-namespace search health results for 10 seconds inside NamespaceSearchRouter. Repeated GET /engram/v1/health and doctor probes reuse the last successful snapshot instead of re-creating and re-probing a temporary QMD backend on every call. clearCache, dispose, and disableSearchBackends drop the cache so later health answers stay honest.

Stability: stable
