---
"@remnic/core": patch
---

Stability: stable

Serialize namespace `meta.json` read-modify-write through `StorageManager.updateMeta` (per-dir in-process chain plus the cross-process `meta.json.lock` advisory lock) and fail the update closed when the lock cannot be acquired, instead of writing unlocked; extraction retry bookkeeping, post-persist counters and empty-success liveness stamps move inside it. This closes the lost-update race between the daemon and concurrent out-of-process buffer-drain workers sharing one memory root (preparation for issue #1526's bounded-parallel extraction queue).
