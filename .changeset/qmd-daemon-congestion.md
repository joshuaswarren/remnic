---
"@remnic/core": patch
---

Stability: stable

Degrade qmd daemon searches to a lex-only plan while the daemon is congested (#3476). When a hybrid daemon query exceeds ~10s or times out — the signature of a saturated shared embedding backend — subsequent searches run lex-only for 60s instead of stacking multi-second lex+vec+hyde calls that stall recall for tens of seconds. Congested results use a separate cache-key namespace so they never pollute normal search results.
