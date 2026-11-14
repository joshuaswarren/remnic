---
"@remnic/core": patch
---

When the local LLM answers an extraction request but nothing in the reply is usable (`local_llm_error: parse_empty`), log one privacy-safe warning: reply length, the completion's `finish_reason`, whether the reply starts with `{`, how many JSON candidates were tried, whether any parsed, how many parsed but had the wrong shape, identifier-shaped top-level key names (at most 8), and how many partial facts were salvaged. The reply content is never logged. The thrown error and its `parse_empty` classification are unchanged. Closes #3387.

Stability: stable
