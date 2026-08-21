---
"@remnic/core": minor
---

Persist versioned weekly time/activity snapshots under `activity/weekly/` (issue #2052). Same inputs skip rewrite by content hash. A changed source revision or config hash writes a new namespace-scoped file and does not mutate another week. Part of #2052.
