---
"@remnic/core": patch
---

Back off when the local LLM endpoint is rate limited. A `429`, `503`, `408`, or LiteLLM `No deployments available` / cooldown response is now retried with exponential full-jitter backoff that never undercuts the server's `Retry-After` header or `Try again in N seconds` hint, capped by `localLlmRateLimitRetryCount` (default 3) and `localLlmRateLimitBackoffMaxMs` (default 60000). The wait is shared across every client in the process for that endpoint, so one 429 slows all callers instead of letting caller loops re-fire immediately. A new process-wide `localLlmMaxConcurrency` cap (default 4, `0` = unlimited) bounds concurrent local LLM HTTP attempts, serving recall-critical requests first. Recall scope, budgets, and timeouts are unchanged.

Stability: stable
