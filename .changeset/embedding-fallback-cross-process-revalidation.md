---
"@remnic/core": patch
---

Warm embedding searches now detect index changes from peer processes (#3165). Changed file or shard-directory metadata invalidates the cached index. Unchanged metadata avoids index reads. Real cross-process tests cover identity changes, same-identity writes, and in-place shard updates.
