---
"@remnic/core": minor
---

Stability: stable

Make the daemon's background extraction queue concurrency configurable (`extractionQueueConcurrency`, positive integer, default 1 = today's serial queue). Tasks sharing a buffer/session key never run concurrently regardless of the limit, preemption becomes per task (a fail-closed flush aborts exactly one armed running extraction — its own session's when present, else the most recently armed — and never cancels queued or non-preemptable work), and queued-abort settlement, retries/error logging, stopAccepting/pauseAndDrain/waitForIdle and front-priority ordering are unchanged. The shared mutable state extraction relied on is isolated so independent sessions can safely overlap: `persistExtraction` now returns this run's judge-deferred count and pending_review ids instead of writing side-channel fields on the orchestrator, and namespace `meta.json` read-modify-write (counters, processed fingerprints, retry/backoff state) is serialized per state dir by an in-process chain plus a cross-process advisory lock (`meta.json.lock`), which also fixes the live lost-update race between the daemon and concurrent out-of-process buffer-drain workers. The per-process model limiter and its foreground reservation are untouched; the knob applies at daemon start.
