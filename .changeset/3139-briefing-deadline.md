---
"@remnic/core": patch
"@remnic/cli": patch
---

Stability: stable

Bound the CLI briefing's startup and body and HTTP/MCP briefing requests with a shared 30-second budget; legacy-data migration that runs before the CLI briefing command is outside it. Budget exhaustion returns an explicit `TimeoutError` (HTTP `504` with code `briefing_timeout`), not an empty successful briefing. Forward caller cancellation to corpus reads, read the location section before the correction-notification drain, and check cancellation before and after reading the notification queue so a cancelled briefing keeps its notifications. Refs #3139; this fixes the unbounded request lifecycle, not the separately tracked QMD slow-search cause.
