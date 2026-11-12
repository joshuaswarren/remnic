---
"@remnic/core": patch
---

Stability: stable

Recall no longer waits for a harmonic graph rebuild when the 30 s cache TTL lapses, and overlapping recalls no longer each run their own rebuild. Concurrent cache misses now share one build (each caller still honors its own abort signal), and a graph whose version stamp is unchanged is served stale for up to 5 minutes past the TTL while one refresh runs behind it. A changed stamp (any memory, node or anchor write) still waits for a fresh build, so a memory that left the active set is never served from a stale graph. On the production daemon the miss cost 7 s (17 to 32 s when two recalls overlapped) against 0.4 to 0.6 s on a hit, and recalls arriving about every 30 s missed most of the time.
