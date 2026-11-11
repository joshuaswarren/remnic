---
"@remnic/core": patch
---

Stability: stable

Remove the private `compareStrings` copy in the entity mention index cache and
import the shared total-order helper from `eval-trajectory-contracts` instead.
Scope-key alias sorting stays the same.
