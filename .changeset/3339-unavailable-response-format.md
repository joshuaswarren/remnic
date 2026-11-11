---
"@remnic/core": patch
---

Extraction against a provider that answers a schema request with "This response_format type is unavailable now" (DeepSeek) now strips the format and retries once, and the model registry records `structuredOutput: "none"`. Before, the 400 was not recognized as a schema rejection, so every observation failed the local call and fell back to the gateway. Closes #3339.

Stability: stable
