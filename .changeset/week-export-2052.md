---
"@remnic/core": minor
---

Add `exportDeterministicWeek` to the activity timeline layer: a pure,
byte-stable JSON week document (`weekStart`, `timezone`, days sorted by date).
No LLM, no I/O, no persistence — same days always produce the same bytes.
Part of #2052.
