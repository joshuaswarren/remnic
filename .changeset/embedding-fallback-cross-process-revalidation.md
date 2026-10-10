---
"@remnic/core": patch
---

Warm embedding searches now detect index changes from peer processes (#3165). Every index publication moves a generation marker to an in-flight value before its writes and writes a fresh completion value after them, so a cached index is invalidated on every publication and a stamp is only ever stable for a completed generation — consecutive publications cannot alias on filesystems with coarse timestamps or reused directory inodes, and a probe racing an in-flight publication revalidates at completion. The marker is node-local: offline sync never snapshots it, and an incoming marker never overwrites or deletes the local one. Unchanged state avoids index reads. Real cross-process tests cover identity changes, same-identity writes, in-place shard updates, aliased stat ticks, and in-flight publication races.

Stability: stable
