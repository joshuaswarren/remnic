---
"@remnic/core": patch
---

LCM summarization now uses the fast local-LLM lane (localLlmFastUrl/localLlmFastModel) instead of the main extraction model. The summarize closure's local branch called the heavy main client, so on deployments where the main model is a large remote model, every lcm-summarize call inherited multi-minute prefill latency — blowing pre-compaction flush budgets (session_before_compact handler timeouts on effectively every compaction) and holding main-lane slots that extraction needed. The gateway branch already used its fast counterpart; the local branch now matches. When the fast lane is disabled, behavior is unchanged (fastLlm falls back to the main client).
