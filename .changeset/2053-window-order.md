---
"@remnic/core": minor
---

Add `assertHalfOpenWindow` for activity range bounds. `toMs <= fromMs` is
empty_window. Non-finite values throw.
Part of #2053.
