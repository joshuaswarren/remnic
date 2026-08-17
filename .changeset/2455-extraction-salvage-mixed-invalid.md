---
"@remnic/core": patch
---

Salvage valid items from mixed-invalid extraction model output: one malformed fact, entity, question, relationship, or profile update no longer discards the whole extraction result. A non-empty array with zero valid items still fails so bounded retry stays effective.
