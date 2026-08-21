---
"@remnic/core": minor
---

Add shared-context claim key parse (issue #1957). `parseClaimKey` trims the value, rejects empty as `missing_key`, rejects an embedded newline as `invalid_key`, and otherwise returns the key. Part of #1957.
