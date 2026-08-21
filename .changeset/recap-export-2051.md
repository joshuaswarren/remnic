---
"@remnic/core": minor
---

Add `exportDeterministicRecap` to the activity timeline layer: a pure,
byte-stable JSON recap document (`date`, `timezone`, cards sorted by id) for
one local day. No LLM, no I/O, no persistence — same cards always produce the
same bytes (issue #2051).
