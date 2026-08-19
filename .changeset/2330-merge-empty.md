---
"@remnic/core": patch
---

Add a merge-id empty-set guard. Empty list is empty_set. Any empty string is empty_id. Otherwise the same ids stay in order. The input list is not mutated. Part of #2330.
