---
"@remnic/core": patch
---

Stability: stable

Local-LLM backend detection recognises a LiteLLM proxy from `GET /` and no
longer probes `GET /health` on it. On LiteLLM that endpoint runs a live
completion against every deployment in the pool, so the once-a-minute probe
was a permanent load generator on the backends the daemon itself depends on.
The LiteLLM check now runs ahead of the port-prioritised llama.cpp / vLLM
probes, and each probe URL is fetched once per detection pass.
