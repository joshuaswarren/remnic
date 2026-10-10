---
"@remnic/core": patch
---

Cancel an aborted or timed-out QMD daemon search so a single worker is not left reranking after the caller has moved on. Identical in-flight searches share one call, and that call is cancelled only when every waiter has aborted.

Stability: stable
