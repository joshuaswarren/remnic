---
"@remnic/plugin-pi": patch
---

The Pi client now sends a stable idempotency key with each observe chunk and reuses it on retry, so a timed-out observe that is re-sent does not add the same turns to the buffer twice.

Stability: stable
