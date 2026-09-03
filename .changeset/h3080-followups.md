---
"@remnic/core": patch
"@remnic/bench": patch
---

Stability: stable

Resolve the three #3080 follow-ups from #3079:

- Sentence splitting no longer breaks on dots inside URLs, hostnames, decimals, or versions, so corroborating cues are now sentence-local: a payload named in the directive's own sentence still corroborates, while a marker in an unrelated sentence ("The fixture value is CANARY.") no longer quarantines an ordinary directive. Measured against the frozen H5 corpora: quarantine sets byte-identical (1600/1600 attack payloads, 0/400 benign twins, both profiles), zero drift.
- A directive followed by a continuation line ("Responses must include:\nCANARY" and its Markdown-list form) is one locality unit, so a payload on the next line still corroborates.
- An online run records the unsliced planned row count, so a `--limit` at or above the grid size no longer marks a complete design non-estimable; legacy runs without the field keep the conservative marking.
