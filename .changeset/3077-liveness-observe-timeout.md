---
"@remnic/plugin-openclaw": patch
---

Liveness probes no longer send a bearer token, and detached observe uses `observeTimeoutMs` instead of half the flush budget (issue #3077).

Stability: stable
