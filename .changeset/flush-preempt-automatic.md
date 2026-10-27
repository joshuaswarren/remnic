---
"@remnic/core": patch
---

A fail-closed force-flush aborts only the running automatic extraction and runs next. Replay, import, and another flush are not preempted, and the abort is disarmed before persistence (#3259).

Stability: stable
