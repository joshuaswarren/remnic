---
"@remnic/core": patch
---

Stability: stable

Recall no longer waits for a harmonic graph rebuild when the 30 s cache TTL lapses. A graph whose version stamp is unchanged is served stale for up to 5 minutes past the TTL while one refresh runs behind it (a failing refresh is retried at most once per TTL). A changed stamp (any memory, node or anchor write) still waits for a fresh build, and so does the instant a source memory's `invalid_at` passes (including during a build, which is rebuilt rather than handed out expired), so neither a memory that left the active set nor an expired one is served from a stale graph. The TTL now counts from when the build finishes. On the production daemon the miss cost 7 s against 0.4 to 0.6 s on a hit, and recalls arriving about every 30 s missed most of the time.
