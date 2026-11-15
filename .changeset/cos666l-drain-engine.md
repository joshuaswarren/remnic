---
"@remnic/core": patch
---

Claim-backed drain extraction now runs on its own extraction engine and local LLM client, with no retry after a timed-out attempt. Before, a drain extraction queued behind every other background request on the shared client (production waits up to 40 minutes) and was retried after a 600 s timeout, so one slow request held its engine slot for 20 minutes. The breaker and per-key backoff already own retrying. Live extraction is unchanged.

Stability: stable
