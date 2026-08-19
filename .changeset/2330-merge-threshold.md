---
"@remnic/core": patch
---

Add a merge-judge skip-threshold helper. Disabled merge skips the judge. `skipThreshold` 0 never skips on score. Scores at or above the skip band skip. Invalid unit-interval inputs throw. Part of #2330.
