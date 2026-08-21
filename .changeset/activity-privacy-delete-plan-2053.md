---
"@remnic/core": patch
---

Add `planActivityDeletion`: a pure planner that selects expired activity
artifacts for deletion, refuses non-activity-owned paths (facts, profile,
entities) so unrelated memories survive, and skips out-of-scope scopes.
Part of #2053.
