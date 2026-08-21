---
"@remnic/core": minor
---

Add shared-context envelope id parse (issue #1957). `parseEnvelopeId` trims the value, rejects empty as `missing_id`, rejects an embedded newline as `invalid_id`, and otherwise returns the id. Part of #1957.
