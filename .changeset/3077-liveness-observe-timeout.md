---
"@remnic/plugin-openclaw": patch
---

Liveness probes anonymously first (200 or 401/403 counts as live) and only send a bearer token if that request returns a non-auth HTTP error with time remaining. Detached observe uses `observeTimeoutMs` instead of half the flush budget (issue #3077).

Stability: stable
