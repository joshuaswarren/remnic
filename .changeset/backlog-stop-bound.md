---
"@remnic/core": patch
"@remnic/server": patch
---

Stability: stable

A daemon stop no longer waits unbounded on the backlog drain. `BacklogScheduler.stop()` now waits at most `stopSettleTimeoutMs` (default 30 s) for aborted drains, logs the key of any drain that ignored abort, and returns so the orchestrator flush and dispose phase runs before the service manager's kill. A buffered extraction aborted while still queued behind a running extraction now reports `onTaskExit` immediately instead of after the queue head finishes, which held the drain's claim lease and the whole stop. The server logs when its listener is bound, with milliseconds since process start.
