---
"@remnic/core": patch
---

Look up buffered access-tracking paths in an index built once per flush instead of scanning the whole corpus (and resolving paths on every comparison) for each update. At ~130k memories the old flush held the event loop for 20 to 40 s and made observe and recall time out (COS-666e).
