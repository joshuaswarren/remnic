---
"@remnic/core": minor
---

Add `parseRecapDate` to the activity timeline layer: trim, reject empty as `missing_date`, and reject strings outside a bounded `YYYY-MM-DD` class as `invalid_date`. Part of #2051.
