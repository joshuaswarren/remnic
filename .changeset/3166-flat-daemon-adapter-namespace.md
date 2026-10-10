---
"@remnic/core": patch
---

Stability: stable

MCP tools use the configured default namespace on flat daemons when a built-in adapter infers its own namespace. Explicit namespaces still receive strict validation. Namespaced daemons retain per-adapter namespaces (#3166).
