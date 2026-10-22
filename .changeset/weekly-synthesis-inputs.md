---
"@remnic/core": patch
---

Weekly compounding synthesis reads in-week correction memories from the memory root and every namespace, reads `memory-actions.jsonl` from each namespace store, and stores `feedback/inbox.jsonl` under the memory directory when `sharedContextDir` is unset. A missing or empty memory-dir inbox is filled once from the legacy workspace inbox. An explicit `sharedContextDir` still owns the inbox. The synthesis behavior stays behind `compoundingEnabled`.

Stability: alpha
Flag: compoundingEnabled
