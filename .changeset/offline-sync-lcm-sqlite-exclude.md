---
"@remnic/core": patch
---

Exclude live LCM SQLite WAL artifacts from offline sync snapshots so large runtime databases are not transferred through JSON sync or deleted from older local caches.
