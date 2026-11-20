---
"@remnic/core": patch
---

Stability: stable

Propagate recall cancellation through persisted entity-index reads and native knowledge collection. A stalled index read no longer keeps the caller waiting after its recall signal is aborted. Add bounded regression coverage for persisted and build-path reads.
