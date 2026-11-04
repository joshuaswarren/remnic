---
"@remnic/core": minor
"@remnic/server": patch
---

Stability: stable

Wire the daemon-owned backlog scheduler into server startup/dispose: `startServer` starts `wireBacklogScheduler(orchestrator)` after the listener opens (claims and buffered sessions drain automatically; bounded paging keeps discovery I/O per tick small) and awaits `stop()` before orchestrator destroy on shutdown. `ServerResult` exposes `backlogScheduler` and `orchestrator` for ops/tests. Ack truthfulness, heartbeat cleanup, stop-race fencing, paged claim discovery, and budget chunking for identity-cleared accepted captures land in `@remnic/core`.
