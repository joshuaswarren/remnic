---
"@remnic/core": patch
---

Loading the memory corpus no longer builds a key-sorted JSON snapshot of every memory (5-7 s of synchronous main-thread work at ~130k facts on each cache rebuild). The tier-move conflict check now derives a memory's load-time snapshot from the file text the loader already retains, at the moment a move needs it.

Stability: stable
