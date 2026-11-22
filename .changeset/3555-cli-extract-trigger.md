---
"@remnic/core": patch
---

Make the CLI extract command trigger extraction for real. It loaded the buffer and then printed an informational message instead of extracting; it now calls the orchestrator's extraction path with the explicit force-flush options and reports the result. Fixes #3555.
