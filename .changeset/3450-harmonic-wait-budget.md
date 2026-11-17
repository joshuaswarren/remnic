---
"@remnic/core": patch
Stability: stable
---

Bound how long a single recall waits for a shared harmonic-graph build. `HARMONIC_GRAPH_WAIT_BUDGET_MS` (default 5000) caps the join: a caller that exceeds the budget rejects with `HarmonicGraphWaitDeadlineError` and the recall harmonic section fails open, while the underlying build keeps running and can still warm the cache for later calls. This prevents recall latency from tracking full graph rebuild time under write churn. Explicit caller aborts still cancel abandoned builds; the uncached path is unchanged. Closes #3450.
