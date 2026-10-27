---
"@remnic/core": patch
---

Allow queued background local-LLM work to obtain a permit under sustained recall-critical traffic when the concurrency cap exceeds one. Preserve recall's reserved capacity, FIFO ordering within each priority, cancellation, and the existing single-permit and unlimited behavior. Fixes #3255.

Stability: stable
