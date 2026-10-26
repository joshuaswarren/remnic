---
"@remnic/core": patch
---

Send the extraction JSON schema on the local LLM path, as on the gateway path, so structured-output backends preserve the required object root. If a local backend rejects the schema with HTTP 400, retry once without the format using the same headers, model, abort signal, and attempt deadline. Preserve the removal for later 5xx retries; unrelated 400/429 responses retain their existing failure and retry behavior.

Stability: stable
