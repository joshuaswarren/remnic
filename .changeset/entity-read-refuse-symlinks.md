---
"@remnic/core": patch
---

Refuse symlinked store files on every secure-store read under the memory root (COS-388c Finding C2). Entity reads share `readStoreFileBuffer`, which now reuses `resolveSafeStoragePath` plus an O_NOFOLLOW open so a post-init `entities/<id>.md` symlink cannot return outside content; list still skips the entry and normal entity files still read.

Stability: stable
