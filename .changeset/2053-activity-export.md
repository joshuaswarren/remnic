---
"@remnic/cli": minor
---

Add `remnic activity-export` for a half-open `[from, to)` JSON export of `{id, capturedAt}`. Missing `--from` exits 1, and `--enabled false` denies. Does not persist. Part of #2053.
