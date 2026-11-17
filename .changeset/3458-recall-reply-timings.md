---
"@remnic/core": patch
---

Recall responses now carry a `timings` field: the per-section timing map the daemon logs as `recall timings:`, carried verbatim from the recall record path (`"4746ms"`, `"skip"`, `"12ms-cache"`), so a client can see which pipeline section dominated a slow recall instead of only `latencyMs`. This is the record-path map, not the `recall_timings` ring-buffer operation's sanitized numeric projection, which drops `"skip"` entries and parses `"12ms-cache"` to `12`. Closes #3458.

Stability: stable
