---
"@remnic/core": patch
---

A force-flush that hits its deadline now aborts that drain, and a later force-flush can preempt it, so an orphaned drain no longer holds the serial extraction queue.

Stability: stable
