---
"@remnic/core": patch
---

Stability: stable

Fail closed when offline-sync census observes a path then hits digest ENOENT:
the snapshot/changeset census throws and must be retried instead of exporting a
silent omission that consumers treat as confirmed absence. Stale incomplete
`currentFiles` lists still recheck disk before emit/apply so a recreated path
is not deleted or overwritten. A locked embedding generation census that loses
any member still fails closed instead of shipping a one-shard subset.

