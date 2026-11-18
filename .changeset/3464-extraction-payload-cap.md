---
"remnic-core": patch
---

Cap each extraction call's rendered payload at `extractionCallMaxChars` (default 12000, applied at the `min(cap, model registry budget)` seam) so a call fits the model's output limit instead of aborting at the timeout. A turn longer than the render clamp now splits into ordered verbatim part copies marked `extractionPartOf: { part, of }` — sentence/paragraph boundaries only, marker metadata never enters the content — and every part is extracted before the parent turn clears. Splits cap at 8 parts per turn; a clamped parent leaves the buffer through the dropped-chunk recovery copy with its full content preserved. Windows that mix oversized turns with exact duplicates take the split path (dedupe cannot fan representatives into parts); nothing is dropped.

Stability: stable

The cap governs automatic drains: forced attempts (`forceExtractionAttempt`) and fail-closed flushes (`failOnExtractionFailure`) keep their one atomic call and may exceed it by design; this is stated in the config reference.

