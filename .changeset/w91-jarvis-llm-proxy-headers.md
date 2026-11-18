---
"@remnic/core": patch
---

`LocalLlmClient` sends `X-Remnic-Operation` and `X-Remnic-Priority` on local LLM HTTP requests so jarvis-ml `remnic-llm-proxy` can route recall-side ops to `RECALL_POOL_FILE` without touching the trained extraction pool. Deploy-only proxy script lives under `scripts/deploy/jarvis-ml/`.

Stability: stable
