---
"@remnic/core": patch
---

Stability: stable

Normalize whitespace and invisible formatting before injection screening. The rule patterns bound their inter-word whitespace for ReDoS safety and match ASCII space and tab only, so three evasions screened clean: a long run of spaces (`must include<40 spaces>CANARY`), any non-ASCII horizontal whitespace as a singleton (`must\u00a0include CANARY`), and zero-width or directionality characters in either placement (`must\u200binclude`, `inc\u200blude`). Runs collapse, non-ASCII spaces become plain spaces, and invisible characters are screened under both readings — deleted and spaced — since only a lexicon could tell the placements apart. Frozen-corpus quarantine sets are byte-identical in both profiles.
