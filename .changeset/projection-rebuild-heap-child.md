---
"@remnic/core": patch
---

Stability: stable

Run the scheduled memory-projection rebuild in a child process and lower its peak heap.

The scheduled rebuild loaded every hot, cold, and archived memory — keeping a raw copy of each file — and the whole lifecycle ledger at once inside the daemon. That aborted the process once the heap was already near Node's default limit. The scheduled path now forks a runner. The child environment is an allowlist of runtime locators, so API keys and secure-store unlock material are not passed through argv or env. Scheduler dispose and parent exit kill the child; if the parent dies without those hooks, the child stops when its IPC channel closes and does not publish the projection. An unlocked encrypted store still rebuilds in-process, because that key is process-local. Corpus reads accept `retainRaw: false` (the rebuild default) so the raw copy and the shared corpus caches are skipped, and the ledger is streamed one event at a time. A scheduled rebuild is postponed, with a warning, when used heap exceeds `projectionRebuildHeapUsageLimit` (default `0.6`).
