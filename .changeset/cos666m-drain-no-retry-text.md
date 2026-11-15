---
"@remnic/core": patch
---

Claim-backed drain extraction makes one model attempt: it is not retried after a failed or timed-out attempt. Setting the drain client's `localLlmRetry5xxCount` to 0 turns off the plain 5xx retry as well as the timeout retry, because both use the same attempt loop. The breaker and per-key backoff own retrying. A new test pins that a drain request starts while a live extraction holds the shared client.

Stability: stable
