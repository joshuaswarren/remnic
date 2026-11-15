---
"@remnic/core": patch
---

Claim-backed drain extraction does not retry after a failed or timed-out model attempt. Setting the drain client's `localLlmRetry5xxCount` to 0 turns off the plain 5xx retry as well as the timeout retry, because both use the same attempt loop. Rate-limit retries (408, 429, 503 and LiteLLM cooldown responses) have their own budget and are unchanged. The breaker and per-key backoff own the remaining retrying. A new test pins that a drain request starts while a live extraction holds the shared client.

Stability: stable
