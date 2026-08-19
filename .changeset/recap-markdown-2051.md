---
"@remnic/core": minor
---

Add `renderRecapMarkdown` to the activity timeline layer: a pure, byte-stable
Markdown recap (`date`, `timezone`, cards sorted by id) for one local day.
Empty days print heading plus `(empty)`. No LLM, no I/O, no persistence.
Part of #2051.
