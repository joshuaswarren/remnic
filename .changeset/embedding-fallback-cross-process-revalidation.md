---
"@remnic/core": patch
---

Warm embedding searches now detect index changes from peer processes (#3165). Every index publication moves a generation marker to an in-flight value before its writes and writes a fresh completion value after them, so a cached index is invalidated on every publication and a stamp is only ever stable for a completed generation — consecutive publications cannot alias on filesystems with coarse timestamps or reused directory inodes, a probe racing an in-flight publication revalidates at completion, a negative (empty) cache is dropped when the stamp moves, and a recovered or rolled-back generation is finalized instead of staying in-flight. The marker is node-local: offline sync never snapshots it, and an incoming marker never overwrites or deletes the local one — across snapshots, changesets, and chunked uploads. Unchanged state avoids index reads. Real cross-process tests cover identity changes, same-identity writes, in-place shard updates, aliased stat ticks, and in-flight publication races.

Stability: stable
