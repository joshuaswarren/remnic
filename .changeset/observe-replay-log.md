---
"@remnic/core": patch
---

An observe request that is answered from the idempotency record (a retry with a known `idempotencyKey`) now logs `access-observe-replay` with the session key and message count. Before this change a replay left no log line, so the dedupe of retried observes could not be counted from the daemon log.

Stability: stable
