---
"@remnic/core": patch
---

Classify local-LLM `finish_reason=length` replies as `output_truncated` instead of `parse_empty`, record the output ceiling (`maxOutputTokens`) in the unusable-reply diagnostic, and long-park the fingerprint so the window is not retried at the same ceiling but still drains under a raised one.
