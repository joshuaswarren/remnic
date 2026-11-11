---
"@remnic/core": patch
---

Refuse buffered-turn admission with retryable backpressure when capacity cannot be made without evicting non-empty entries. Multi-session accepted captures reserve capacity together or are refused whole, preserving retained backlog. Batch admission has no retry identity: a retry after a crash that persisted only a prefix of the sessions duplicates that prefix.

Stability: stable
