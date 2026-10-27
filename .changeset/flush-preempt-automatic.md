---
"@remnic/core": patch
---

A fail-closed extraction flush aborts the running automatic extraction and runs next. The abort happens before accepted turns are cleared, and another fail-closed flush is not preempted (#3259).

Stability: stable
