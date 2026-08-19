---
"@remnic/core": minor
---

Add shared-context envelope actor parse (issue #1957). `parseEnvelopeActor` trims the value, rejects empty as `missing_actor`, rejects an embedded newline as `invalid_actor`, and otherwise returns the actor. Part of #1957.
