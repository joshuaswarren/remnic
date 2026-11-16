---
"@remnic/core": patch
---

With `extractionRetryEnabled: false`, a failed extraction with no durable outputs no longer clears the source turns. Source retention now follows the actual extraction failure instead of the retry bookkeeping, for both `provider_retryable` and `parse_empty` results (the result carries `retainedBuffer` and `failureClass`). Retry and backoff bookkeeping stay gated by the existing setting, and a successful empty extraction still clears the buffer. Retention stays bounded by the existing buffer policy: non-empty backlog is never evicted and new sessions are refused past the cap, so an outage cannot grow the buffer without bound.

Stability: stable
