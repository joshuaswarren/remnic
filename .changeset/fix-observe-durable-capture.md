---
"@remnic/core": patch
---

Persist observe captures in the native extraction buffer before acknowledging them. Keep accepted captures available for retry across extraction cancellation, deadlines, and restart, and refuse new captures when bounded durable admission cannot succeed. Reuse native batching and retain each capture's ownership, namespace, profile, and source identity when draining it.

The observe response's `extractionQueued` field reports whether a trigger actually queued extraction; a durably buffered capture may be accepted before that trigger fires. Explicit replay and `skipExtraction` retain their existing contracts.

Fixes #3251.

Stability: stable
