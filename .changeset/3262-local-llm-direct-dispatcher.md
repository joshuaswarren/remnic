---
"@remnic/core": patch
---

Local LLM transport: setting `REMNIC_LOCAL_LLM_DIRECT=1` makes the widened undici pool apply even when the process installed its own global dispatcher (for example an agent runtime's managed proxy). Without it the installed dispatcher keeps its own `headersTimeout` (undici defaults to 300s; on the hosts where this was seen the proxy dispatcher enforced it), so a non-streaming completion slower than that limit dies with `fetch failed` at about 301s, whatever `localLlmTimeoutMs` says. Availability probes follow the same route. The variable is read by the transport only (it is not a `parseConfig` gate); unset, the behavior is unchanged.

Stability: stable
