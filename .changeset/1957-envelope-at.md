---
"@remnic/core": minor
---

Add shared-context envelope at parse (issue #1957). `parseEnvelopeAt` trims the value, rejects empty as `missing_at`, rejects an unparsable timestamp as `invalid_at`, and otherwise returns the ISO instant. Part of #1957.
