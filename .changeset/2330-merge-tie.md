---
"@remnic/core": patch
---

Add a merge-tie breaker. Lower id by localeCompare wins. Same id returns aId. Empty id throws. Part of #2330.
