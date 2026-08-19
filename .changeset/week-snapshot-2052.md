---
"@remnic/core": minor
---

Add `renderWeekSnapshot` to the activity timeline layer: a pure,
byte-stable markdown week document (`weekStart`, `timezone`, days sorted by date).
Empty days print heading + (empty). No LLM, no I/O, no persistence.
Part of #2052.
