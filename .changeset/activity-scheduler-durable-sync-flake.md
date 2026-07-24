---
"@remnic/core": patch
---

Make the activity scheduler `parser -> scheduler -> durable sync` test
deterministic. The test fired a scheduler tick (fire-and-forget
`runActivitySyncOnce` with real fs + SQLite I/O on the libuv threadpool)
and then waited a single `setImmediate` before asserting — a race that
flaked in CI when the durable writes had not settled. It now waits on an
`onRun` completion signal (the scheduler invokes `onRun(summary)` only
after the sync promise resolves), so the assertions run exactly once the
sync is durable. No sleeps, no production changes.
