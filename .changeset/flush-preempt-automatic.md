---
"@remnic/core": patch
---

A fail-closed force-flush waits for observe admission, then aborts only the in-flight extraction and drains the preserved turns. It does not cancel the preparation barrier. Replay and import stay protected, and buffer clears disarm preemption first (#3259).

Stability: stable
