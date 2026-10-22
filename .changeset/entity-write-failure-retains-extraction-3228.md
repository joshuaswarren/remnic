---
"@remnic/core": patch
---

Propagate entity persistence failures so extraction retains source turns and does not mark failed input processed. Reuse the best-effort deferred fact-hash flush before reporting an entity write error. Fixes #3228.

Stability: stable
