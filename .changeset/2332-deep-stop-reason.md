---
"@remnic/core": patch
---

Add a deep-recall stop-reason parser. Allow budget_exhausted, policy_stop, expand_once, and refine_done. Unknown or empty values return unknown_reason. Part of #2332.
