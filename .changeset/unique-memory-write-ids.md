---
"@remnic/core": patch
---

Use timestamped UUIDs for memory and artifact IDs to prevent concurrent writes from overwriting one another. Measure the final serialized size when shrinking navigation results so long IDs do not remove a disclosure that fits within the configured budget.

Stability: stable
