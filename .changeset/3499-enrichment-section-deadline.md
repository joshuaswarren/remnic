---
"@remnic/core": patch
---

Stability: stable

Enforce the recorded enrichment section deadline with a timer on the child abort handle, so harmonic retrieval, QMD and native-knowledge enrichment cancel inside the remaining request budget instead of running past the 60 s client deadline. A cut section records `timeout` and the `deadline_exceeded` degradation, and keeps a value it still delivered such as a stale-cache fallback (#3499).
