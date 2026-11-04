---
"@remnic/core": patch
---

Stability: stable

Make `ThreadingManager`'s thread-run state session-scoped (bounded LRU map) and eviction-safe for in-flight `processTurn` calls, so concurrent extractions (issue #1526) can no longer attach turns to the wrong thread or lose a parked session's thread id.
