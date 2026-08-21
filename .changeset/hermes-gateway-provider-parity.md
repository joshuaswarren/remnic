---
"@remnic/core": patch
---

Make gateway model-source extraction tolerate OpenClaw provider catalog drift by resolving legacy `openai-codex/...` model refs through the current `codex` provider and by supplying safe built-in Anthropic defaults when the materialized provider catalog is unavailable.
