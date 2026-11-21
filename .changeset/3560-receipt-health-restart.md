---
"@remnic/core": patch
Stability: stable
---

The memory controller keeps its `recent_receipt_failures` demotion across a restart. `MemoryControllerRecorder` accepts an optional `trailingReceiptFailures()` that returns the count of failed outcomes at the end of the recorded stream; a new coordinator seeds its receipt-failure counter from it before the first active-mode gate check. If the history cannot be read, the run demotes to shadow. Recorders without the method behave as before. Refs #3560.
