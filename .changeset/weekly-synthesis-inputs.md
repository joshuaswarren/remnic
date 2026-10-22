---
"@remnic/core": patch
---

Weekly compounding synthesis reads in-week correction memories from the memory root and every namespace, reads `memory-actions.jsonl` from each namespace store, and stores `feedback/inbox.jsonl` under the memory directory when `sharedContextDir` is unset. An explicit `sharedContextDir` still owns the inbox. The synthesis behavior stays behind `compoundingEnabled`.

Stability: alpha
Flag: compoundingEnabled
