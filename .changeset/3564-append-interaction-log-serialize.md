---
"@remnic/core": patch
Stability: stable
---

`appendInteractionLog` now serializes appends per log file in-process: concurrent callers' entries land in submission order and one entry can no longer be split by another writer's chunk. Ordering across separate processes remains the caller's responsibility. Closes #3564.
