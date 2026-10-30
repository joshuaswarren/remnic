---
"@remnic/core": patch
---

Reserve one concurrency permit for recall-critical local LLM work when the existing process-wide cap is greater than one. Background work cannot occupy every permit; one-permit and unlimited configurations keep their existing behavior. Preserve FIFO priority, cancellation, bounded waits, resizing, and idempotent release without adding another queue or setting.

Stability: stable
