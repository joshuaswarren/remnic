---
"@remnic/plugin-pi": patch
---

MCP tool registration no longer gives up silently when tools/list fails at session start: the catalog request is retried once when startup budget remains, and any terminal failure records a `MCP_TOOLS_LIST_FAILED` warning state entry (and a console warning) instead of leaving the session with zero Remnic tools and no signal — recall kept working, so the session looked healthy. The retry floor (250ms) only gates whether a second attempt starts; the configured `startupRequestTimeoutMs` is always honored exactly.

Stability: stable
