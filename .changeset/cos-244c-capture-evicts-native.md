---
"@remnic/core": patch
Stability: stable
---

Durable observe capture no longer fails with "extraction buffer at entry capacity" when stalled extraction fills the session-entry cap with native (non-accepted) sessions. Admission now evicts the oldest empty or non-accepted entries, the same policy the native path already uses, instead of pruning only empty ones. Accepted captures are still never evicted.
