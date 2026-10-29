---
"@remnic/core": patch
"@remnic/plugin-openclaw": patch
"@joshuawarren/openclaw-engram": patch
---

Stability: stable

A session whose buffered window outgrows the local extraction model's context no longer stalls forever. The extraction trigger splits the window into chunks that fit the model's learned context, clears each chunk as it succeeds, and after `extractionChunkDropAfterFailures` (default 5) consecutive failures copies the stuck chunk to `state/dropped/` and drops it so later chunks drain. Breaker and backoff skips never count as failures, a chunk without a saved recovery copy is never dropped, and replay, import, force-flush and accepted-capture runs are never chunked.
