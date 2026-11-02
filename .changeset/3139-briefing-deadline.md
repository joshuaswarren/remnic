---
"@remnic/core": patch
"@remnic/cli": patch
---

Stability: stable

Bound the CLI briefing's startup and body and HTTP/MCP briefing requests with a shared 30-second budget; legacy-data migration that runs before the CLI briefing command is outside it. Budget exhaustion returns an explicit `TimeoutError`, not an empty successful briefing. Forward caller cancellation to corpus reads and check it before starting the correction-notification drain. Refs #3139; this fixes the unbounded request lifecycle, not the separately tracked QMD slow-search cause.
