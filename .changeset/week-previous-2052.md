---
"@remnic/core": patch
---

Add `compareWeeklyPreviousPeriod` to compare weekly duration totals against
the previous week. Missing or timestamp-less previous periods return
`{ available: false }` instead of zero deltas. Non-finite durations throw.
Part of #2052.
