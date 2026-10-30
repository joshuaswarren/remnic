---
"@remnic/plugin-pi": patch
---

Stability: stable

Do not call omp action methods while the extension is loading. omp 18.x throws `ExtensionRuntimeNotInitializedError` from `appendEntry` during load, so a failed or filtered MCP `tools/list` at load (for example a 503 from the daemon path) failed the whole Remnic extension load. Load-time state entries are now queued and flushed on the first `session_start`.
