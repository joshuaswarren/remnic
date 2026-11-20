---
"@remnic/core": patch
Stability: stable
---

`ExtractionQueueCoordinator.pauseAndDrain` no longer waits forever past its nominal budget. After the first `timeoutMs` expires it grants a bounded grace wait — `tailBudgetMs`, a new second parameter defaulting to 15 seconds — then stops waiting and reports `false` instead of the previous unconditional `true`. Shutdown therefore cannot stall on an extraction task that never settles, and the existing "extraction queue did not drain" error path in `orchestrator.destroy` becomes reachable. Both the timeout warning and the new abandonment warning name the outstanding entries (in-flight and queued keys) and elapsed milliseconds. Buffered turns are persisted before the drain runs, so an abandoned tail loses no durable turn data. Refs #3517.
