---
"@remnic/core": patch
---

Stability: stable

Stop harmonic recall from scanning the whole memory corpus before phase-2 can format already-finished QMD hits. When the projection index is openable, source checks read those ids (plus same-day paths and cold misses) instead of every hot file. No projection file keeps the previous full scan.
