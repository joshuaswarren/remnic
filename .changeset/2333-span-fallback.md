---
"@remnic/core": patch
---

Add `tallySpanFallbacks`, an internal pure helper that tallies per-fact span-validation outcomes ("span" / "fallback") into the `fallbackRatePct` percentage the Phase B gate consumes. Unknown outcomes throw instead of bucketing as successes. Not wired into a caller yet; extraction wiring is a later slice. Part of #2333
