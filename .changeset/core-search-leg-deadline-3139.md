---
"@remnic/core": patch
---

Give each cross-namespace search leg its own 25 second budget. One namespace whose backend never answers now reports `deadline_exceeded` for that namespace and returns empty results for it, while the other namespaces still return. Caller aborts keep rejecting the whole search as before. Part of #3139.

Stability: stable
