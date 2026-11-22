---
"@remnic/core": patch
Stability: stable
---

Test-only: the heartbeat surface watch callback-failure test waits for the warning (up to 2 s) instead of a fixed 100 ms, so file-event latency on a loaded CI runner no longer fails it. No runtime change. Closes #3683.
