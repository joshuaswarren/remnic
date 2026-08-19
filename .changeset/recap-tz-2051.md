---
"@remnic/core": minor
---

Add `normalizeRecapTimezone` to the activity timeline layer: trim, reject empty as `missing_timezone`, and reject strings outside a bounded `[A-Za-z0-9_+/-]{1,64}` class as `invalid_timezone`. Part of #2051.
