---
"@remnic/core": patch
---

Memoize git project resolution per cwd for 30s on the recall and memory_store paths. Each miss spawned up to five `git` processes on the event loop; under steady traffic this was ~5% of main-thread time on a production host and contributed to MCP request timeouts (COS-666).
