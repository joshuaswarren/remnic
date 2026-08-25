---
"@remnic/cli": patch
---

Warm `converge plan`/`watch` cycles reuse `StorageManager`'s persisted digest cache instead of re-hashing every file, and honor `offlineSyncExcludes` (plus `includeTranscripts: false`) so node-local state and transcripts are not planned as failed pushes. Plan-phase stderr now reports identity-cache hit/miss counts and snapshot/manifest wall time.
