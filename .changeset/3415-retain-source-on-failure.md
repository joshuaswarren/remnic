---
"@remnic/core": patch
---

With `extractionRetryEnabled: false`, a failed extraction with no durable outputs no longer clears the source turns. Source retention now follows the actual extraction failure instead of the retry bookkeeping, for both `provider_retryable` and `parse_empty` results (the result carries `retainedBuffer` and `failureClass`). Retry and backoff bookkeeping stay gated by the existing setting, and a successful empty extraction still clears the buffer. Retention is bounded by a new per-session turn cap (`bufferMaxTurnsPerSession`, default 200): a full session refuses new turns with retryable backpressure instead of growing without bound during an outage, and no buffered turn is ever dropped to admit new ones. The session-entry cap still bounds the number of sessions.

Stability: stable
