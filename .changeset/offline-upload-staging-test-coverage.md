---
"@remnic/core": patch
---

Added real-filesystem coverage for offline upload staging (#3164). Tests cover complete uploads, gaps, resets, cleanup, storage hooks, and symlink rejection. A reset with different bytes fails the real consumer checksum check. The staging module now owns `OfflineUploadStaging`; the duplicate interface is removed.
