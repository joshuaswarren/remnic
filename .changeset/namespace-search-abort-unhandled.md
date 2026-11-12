---
"@remnic/core": patch
---

A recall whose caller had already aborted no longer crashes the daemon. `NamespaceSearchRouter` raced each backend leg against the abort signal and, when the signal was already aborted, returned its own rejection without attaching a handler to the leg. The leg then rejected with `QMD inflight search aborted` and nothing was listening, so Node exited the process (jarvis-ml, 12 Nov 2026). The leg's rejection is now consumed.

Stability: stable
