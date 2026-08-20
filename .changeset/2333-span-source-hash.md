---
"@remnic/core": patch
---

Add a span source stamp and verify helper. The stamp records the sha256 and length of the exact string sent to the model; verification compares length first, then the digest, and reports `length_mismatch` or `hash_mismatch` with both stamps. Malformed stamps throw before comparison. The helper is exported from `@remnic/core`; extraction wiring is unchanged. Part of #2333.
