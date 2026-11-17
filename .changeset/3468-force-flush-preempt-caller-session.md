---
"@remnic/core": patch
---

Force-flush preemption now scopes to the caller's session: `extractionForceFlush`'s preemption callback forwards the caller's session key to `preemptRunning(preferredKey?)` instead of calling it keyless, which aborted whichever background task armed last - typically the backlog scheduler's buffer drain - while the caller's own queued extraction stayed blocked. New `forceFlushPreemptCallback` helper with failing-first tests. No-drop semantics unchanged; buffered turns are never dropped or sampled.

Stability: stable
