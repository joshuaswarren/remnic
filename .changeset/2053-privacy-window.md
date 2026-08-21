---
"@remnic/core": minor
---

Add `filterPrivacyWindow` for a half-open `[fromMs, toMs)` activity window.
`retainDays` 0 keeps all ages. `retainDays` N drops items older than N days before `toMs`.
Part of #2053.
