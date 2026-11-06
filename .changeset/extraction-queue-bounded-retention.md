---
"@remnic/core": patch
---

Stability: stable

Bound the queued automatic extraction snapshots' retained memory by structural sharing instead of per-snapshot deep copies. While the drain is slower than the trigger cadence, every buffered turn re-triggers extraction and used to enqueue a full prefix snapshot copy per trigger, so queued retention grew with the sum of all overlapping snapshots (measured scaling exponent 1.89 on the controlled workload before this change). Automatic-path snapshots for the same buffer key now chain onto the still-queued snapshot when it is an element-wise, consumer-equivalent prefix (verified per turn across every `BufferTurn` field, including the ones `bufferTurnsEqual` ignores), and each task materializes its own fresh window at run time. Distinct scope pins never share; per-entry settlement, FIFO order, front preemption, and all extraction windows are unchanged. Replay, bulk import, force flush, fail-closed callers, and claim-backed execution contexts are excluded from sharing.
