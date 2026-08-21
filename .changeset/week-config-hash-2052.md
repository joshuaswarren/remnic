---
"@remnic/core": patch
---

Add `computeWeeklyConfigHash`: an order-stable digest of timezone, week start,
and category definitions for weekly snapshot identity. The helper is exported
from the activity timeline entry; caller wiring is a later slice.
Part of #2052.
