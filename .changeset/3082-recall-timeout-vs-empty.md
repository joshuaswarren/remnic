---
"@remnic/core": patch
---

Stability: stable

recall distinguishes a QMD daemon timeout from a genuine empty result (#3082). Fatal search degradations surface as `retrievalFailure` plus `contextComposition.degradation` instead of `count: 0` with no marker. Honest no-match stays marker-free.
