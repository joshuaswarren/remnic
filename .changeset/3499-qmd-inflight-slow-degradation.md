---
"@remnic/core": patch
---

Stability: stable

Degrade daemon searches to the scoped lex-only plan while a hybrid or vector query on the same qmd daemon session is already past the slow-query threshold, before its result opens the congestion window. The marker clears on success, failure, and cancellation; idle sessions keep the hybrid plan. First recall after a restart no longer stacks a full hybrid query behind an already-stalled one (#3499).
