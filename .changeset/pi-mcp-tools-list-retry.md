---
"@remnic/plugin-pi": patch
---

MCP tool registration no longer gives up silently when tools/list fails once at session start: the catalog request is retried within the remaining startup budget, and a persistent failure records a `MCP_TOOLS_LIST_FAILED` warning state entry (and a console warning) instead of leaving the session with zero Remnic tools and no signal — recall kept working, so the session looked healthy.
