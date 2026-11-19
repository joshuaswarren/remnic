---
"@remnic/core": patch
---

Observe buffer retries after a post-flush failure no longer duplicate turns: durable admission idempotency keys on the buffered ingest path are persisted in buffer state (bounded store). Closes #3368.

Stability: stable
