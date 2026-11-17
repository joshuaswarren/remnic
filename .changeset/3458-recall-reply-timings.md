---
"@remnic/core": patch
---

Recall responses now carry a `timings` field: the same per-section timing map the daemon logs as `recall timings:` and exposes through the `recall_timings` ring-buffer operation. Previously a client saw only `latencyMs` and could not tell which pipeline section dominated a slow recall. Values are formatted strings (`"4746ms"`, `"skip"`, `"12ms-cache"`) rendered verbatim from the record path. Closes #3458.

Stability: stable
