---
"@remnic/core": patch
---

Stability: stable

Repair the namespace catalog automatically after a read skipped malformed rows. `listNamespaces()` keeps reporting the incomplete read, and now schedules the same fold-and-rewrite the size-triggered compaction uses: the readable rows survive, the malformed ones are dropped, so a permanently bad row no longer keeps every entity-migration completion request owed. The rewrite runs inside the in-process critical section and under the held catalog file lock. It waits at most 500 ms for that lock — catalog operations are never stalled for a full rebuild-lock window — and if the wait times out the rewrite is dropped, not queued; the next incomplete read retries. Best-effort and fail-open. Fixes #3297.