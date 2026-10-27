---
"@remnic/core": patch
---

A fail-closed force-flush aborts only the running automatic extraction and runs next. Replay, import, and another flush are not preempted. The abort is disarmed before persistence, and a preempted observe does not block that session's next flush (#3259).

Stability: stable
