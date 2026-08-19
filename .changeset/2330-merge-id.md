---
"@remnic/core": patch
---

Add a merge-target id picker. Empty candidates return null. Otherwise the lowest id by localeCompare wins. The input list is not mutated. Part of #2330.
