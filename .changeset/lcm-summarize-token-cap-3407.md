---
"@remnic/core": patch
---

LCM summarize requests now scale target and max completion tokens to the prompt slice actually sent (12k chars), so 16k-capped endpoints no longer see oversize max_tokens from whole-batch estimates. Closes #3407.

Stability: stable
