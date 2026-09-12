---
"@remnic/core": patch
---

Stability: stable

Deep-recall seed search now drops a hit when its path fails to resolve to a stored memory instead of falling back to the search backend's bare docid. A docid can name a document in a foreign collection, so it must never enter the deep-recall working set as a resolved memory id. Index-unavailable failures still report `backend_unavailable` as before. Fixes #3087.
