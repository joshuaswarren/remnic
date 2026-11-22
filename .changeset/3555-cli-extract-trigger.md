---
"@remnic/core": patch
Stability: stable
---

Make the CLI extract command trigger extraction for real. It loaded the buffer and then printed an informational message instead of extracting; it now drains every buffered session key (real captures buffer under their session key, not "default") through the orchestrator's extraction path with the explicit force-flush options, and exits nonzero when a session's extraction is skipped or fails. Fixes #3555.
