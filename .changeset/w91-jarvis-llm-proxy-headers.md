---
"@remnic/core": patch
---

`LocalLlmClient` sends `X-Remnic-Operation` (and `X-Remnic-Priority` for operator visibility) on local LLM HTTP requests. Jarvis-ml `remnic-llm-proxy` routes recall-side ops to `RECALL_POOL_FILE` from `X-Remnic-Operation` only; Priority is not used for pool selection. Deploy-only proxy script lives under `scripts/deploy/jarvis-ml/`.

Stability: stable
