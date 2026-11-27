---
"@remnic/core": patch
Stability: stable
---

The explicit-`maxEntities`/`maxChars` recall path now reuses the warm scored entity index inside its reuse window instead of rereading the cold corpus, and scoped mention-cache hits require the full identity — mention epoch and shared entity revision — so a linked-memory write or a peer `StorageManager` write can no longer be served a stale index or skip the reconciliation the resolver would have armed. Refs #3529.
