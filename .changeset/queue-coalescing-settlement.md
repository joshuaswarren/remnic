---
"@remnic/core": patch
---

Stability: stable

Keep queued extraction tasks for a shared buffer key independent. Each captured scope runs and settles under its own pins, including when a front task preempts the running task.
