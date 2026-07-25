---
"@remnic/core": patch
---

Expose `busyWorkers` on the archive-scoring worker pool and `OffThreadArchiveScoring` — the count of workers actually scoring, as distinct from callers queued in `acquire()`. The concurrency regression tests for issue #1674 previously inferred parallelism from wall-clock latency ratios, which flaked whenever a loaded runner inflated the single-call baseline; they now observe worker overlap directly, which needs this distinction to be meaningful (a caller-side counter reports K even for a size-1 pool).
