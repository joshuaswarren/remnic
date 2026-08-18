---
"@remnic/core": patch
---

Add a default-off merge-on-write judge helper. Scores in `[0.80, 0.92)` may merge. Skip-band scores, refused categories, judge failure, and `mergeMin=0` stay create. Part of #2330.
