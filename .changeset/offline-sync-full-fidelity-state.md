---
"@remnic/core": patch
"@remnic/cli": patch
---

Make offline sync full-fidelity by syncing durable runtime state files, including LCM SQLite archives and lifecycle ledgers, while continuing to exclude only transient sync/temp files. Large local state files now push back through a chunked binary path instead of oversized JSON changesets.
