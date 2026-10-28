---
"@remnic/core": patch
---

Local LLM transport: setting `REMNIC_LOCAL_LLM_DIRECT=1` makes the widened undici pool apply even when the process installed its own global dispatcher (for example an agent runtime's managed proxy). Without it the 300s `headersTimeout` cap stands silently on such hosts and every non-streaming completion slower than five minutes dies with `fetch failed` at 301s, whatever `localLlmTimeoutMs` says. The variable is read by the transport only (it is not a `parseConfig` gate); unset, the behavior is unchanged.

Stability: stable
