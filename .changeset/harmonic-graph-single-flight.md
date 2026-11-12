---
"@remnic/core": patch
---

Stability: stable

Overlapping recalls no longer each run their own harmonic graph rebuild. Concurrent cache misses now share one build per cache key, so two recalls that land on a cold or expired cache wait for one rebuild instead of two (on a 2106 node, 9174 anchor graph a rebuild is about 5 s standalone and 17 to 32 s when two ran at once). Each caller still honors its own abort signal: an aborted caller leaves the shared build running for the others. A failing build rejects every caller that joined it and the next read retries. The cache TTL, the stamp check and the frozen result are unchanged.
