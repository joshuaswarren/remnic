---
"@remnic/core": minor
---

Add shared-context envelope required-actor parse (issue #1957). `parseRequiredActor` trims the value, treats empty as no requirement, rejects an embedded newline as `invalid_required`, and otherwise returns the required actor. Part of #1957.
