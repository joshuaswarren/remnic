---
"@remnic/core": minor
---

Drain the persisted extraction backlog inside the daemon. `BufferDrainRunner` runs claim-backed drains through the shared extraction queue as isolated per-task executions (no global buffer swap), groups claim turns by captured extraction scope with current-policy re-applied from the original binding, and runs with an explicit no-drop policy: repeatedly failing chunks stay in the claim as durable retryable backlog. New `BacklogScheduler` (`wireBacklogScheduler(orchestrator)`) owns startup, new-work, and retry scheduling with bounded memory and the extraction queue's own concurrency as the in-flight bound; policy-denied groups stay pending and are reported via `DrainSessionOutcome.denied` and `BacklogScheduler.snapshot()`. `ExtractionQueueCoordinator` gains synchronous `tryReserveKey`/`releaseKeyReservation` so claim decisions fence same-key live work; `ExtractionDrain` gains `{ dropFailedChunks: false }` (default unchanged).
