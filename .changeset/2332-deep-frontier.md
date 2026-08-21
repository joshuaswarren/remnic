---
"@remnic/core": patch
---

Add a pure deep-recall frontier ranker. Drops blank ids and invalid counts, dedups by node, sorts by shared anchors then id, and caps at 20. Part of #2332.
