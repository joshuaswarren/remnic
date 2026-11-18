---
"@remnic/core": patch
---

Wire HTTP/MCP `recall.searchOptions` through to QMD (`query` tool), including cold fallback. Per-call `rerank: false` maps to `--no-rerank`. R4 QMD search-cache recall scope is reference-counted for concurrent recalls.

Stability: stable