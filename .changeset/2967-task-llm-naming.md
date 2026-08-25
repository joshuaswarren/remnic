---
"@remnic/core": patch
---

Give the primary gateway/task LLM path honest config keys and log prefixes (issue #2967). `taskLlmTimeoutMs` and `taskLlmFallback` are the current names; `localLlmTimeoutMs` and `localLlmFallback` remain documented legacy aliases, read only when the new key is absent, with a one-time warn. User-facing `fallback LLM:` log prefixes become `task LLM:`. The `FallbackLlmClient` class/file stay: too many imports and test stubs to rename in this change; `TaskLlmClient` is exported as an alias.
