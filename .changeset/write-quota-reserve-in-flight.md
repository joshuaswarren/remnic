---
"@remnic/core": patch
---

Write quota admission now reserves in-flight capacity instead of only checking committed writes. Concurrent writes with distinct payloads could all pass the same capacity check and overshoot the per-principal write limit; admission now takes an atomic reservation that commits at the durable boundary and is released when a write is rejected, fails, or is exempt (dry run or idempotent replay), so no more than the configured limit is admitted at once.

Stability: stable
