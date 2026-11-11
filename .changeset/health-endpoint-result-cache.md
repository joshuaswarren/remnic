---
"@remnic/core": patch
---

Cache healthy per-namespace search health results for 10 seconds inside NamespaceSearchRouter. Repeated GET /engram/v1/health and doctor probes reuse the last available, non-missing snapshot instead of re-creating and re-probing a temporary QMD backend on every call. Unavailable, missing, aborted, and thrown probes are never cached, so readiness polls see recovery on the next call. clearCache, dispose, and disableSearchBackends drop the cache so later health answers stay honest.

Stability: stable
