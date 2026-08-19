---
"@remnic/core": patch
---

Advertise MCP tools as `remnic_*` so names match Anthropic `^[a-zA-Z0-9_-]{1,64}$`.
`remnic.*` and `engram.*` stay callable. `emitLegacyTools=false` lists `remnic_*` only.
Fixes #2705.
