---
"@remnic/core": patch
---

Stability: stable

Drive the profiling collector's parallel-group wall-time test with a fake clock so it no longer depends on real timers and the wall clock (test-only). Runtime behavior stays the same. Refs #3294.
