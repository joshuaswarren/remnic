---
"@remnic/core": patch
Stability: stable
---

`validateLocalLlmModel` no longer rewrites `config.localLlmMaxContext` in memory when it exceeds the loaded model's context window. It now warns the operator to lower the persisted `localLlmMaxContext` to the reported window; until then the configured value stays in effect. Closes #3562.
