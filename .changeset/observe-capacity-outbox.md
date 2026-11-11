---
"@remnic/core": patch
"@remnic/plugin-pi": patch
---

Observe backpressure is now actionable for clients. A permanently invalid capture (missing storage target) answers 400 storage_target_required instead of a retryable 503, MCP marks it retryable false, and a capacity 503 logs a warning with the request correlation id and carries a short advisory retry-after. The Pi client queues refused or timed-out observes in a durable, locked, multi-process-safe outbox (re-read and merge under a file lock, unique temp files), keeps captures on 429, 408, 502, 503 and 504, parks the whole queue on 401 and 403, and replays under a per-entry random idempotency nonce so repeated identical turns never collide. Replays older than the daemon idempotency window warn that a duplicate is possible. A failed enqueue is reported instead of losing the turn silently.

Stability: stable
