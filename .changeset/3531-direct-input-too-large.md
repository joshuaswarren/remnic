---
"@remnic/core": patch
Stability: stable
---

Report an oversized direct-client extraction request as `direct_input_too_large` instead of a gateway "no parsed output".

When the direct OpenAI-compatible client refuses the window as too large (HTTP 413, or HTTP 400 naming a size or context limit) and the gateway fallback cannot serve it either, extraction now fails with `direct_input_too_large` and logs the request size. A fail-closed flush throws `extraction failed: direct_input_too_large`. The class stays `provider_retryable`, so the retained turns are never parked or dropped, and `remnic buffer drain` can still extract them in budget-sized chunks. Atomic flushes are still never split or truncated, and the gateway fallback still runs first.
