---
"@remnic/core": patch
---

A fail-closed force-flush aborts the in-flight observe extraction before waiting, then runs next. Replay and import stay protected. Buffer clears disarm preemption first, so an abort cannot drop accepted turns the flush still needs (#3259).

Stability: stable
