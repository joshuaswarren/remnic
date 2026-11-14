---
"@remnic/server": patch
---

Log a warning to daemon.log when event-loop lag crosses p99 250ms or max 1s in a 30s window, so MCP request timeouts can be told apart from slow downstream LLM/QMD calls (COS-666).

Stability: stable
