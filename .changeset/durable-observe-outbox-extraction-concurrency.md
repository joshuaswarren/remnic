---
"@remnic/core": minor
"@remnic/plugin-pi": minor
"@remnic/plugin-openclaw": minor
"@joshuaswarren/openclaw-engram": minor
---

Durable observe outbox and bounded extraction concurrency. The extraction queue's default concurrency is now 2 (was 1); per-session serialization and every existing backpressure bound are unchanged, and an explicit `extractionQueueConcurrency` still wins. The observe outbox no longer evicts accepted captures at the 200-entry in-memory bound: overflow spills atomically into private (0600/0700) bounded disk segments and replays FIFO across restarts and concurrent writers. Ambiguous failures (timeouts, unrecognized 5xx) are retained past the retry cap instead of dropped; permanent rejections stay queued at the FIFO head with their HTTP status and replay key. Known limits: a deployment that explicitly sets `extractionQueueConcurrency: 1` stays serial; a permanent rejection pins the FIFO until corrected; replays older than the daemon's idempotency window may duplicate (each warns on replay).

Stability: stable
