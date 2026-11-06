---
"@remnic/core": patch
Stability: stable
---

Refuse buffered-turn admission with retryable backpressure when capacity cannot be made without evicting non-empty entries. Multi-session accepted captures reserve capacity together and deduplicate turns across retries after interrupted persistence, preserving retained backlog.
