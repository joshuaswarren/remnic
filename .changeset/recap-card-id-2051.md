---
"@remnic/core": minor
---

Add `parseRecapCardId` to the activity timeline layer: trim, reject empty as `missing_id`, and reject an embedded newline as `invalid_id`. Part of #2051.
