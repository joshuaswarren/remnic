---
"@remnic/core": patch
---

Recalls without a sessionKey (every MCP recall) no longer parse the whole 12 hour transcript window (~614 MB on a large store, ~7 s of main-thread work). Daily files are read from their tail and skipped when not modified since the window began, and the recall transcript section reads only the newest `maxTranscriptTurns` entries.

Stability: stable
