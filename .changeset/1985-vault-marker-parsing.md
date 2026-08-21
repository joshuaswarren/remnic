---
"@remnic/core": minor
---

Reject `:` in managed-region names and parse marker names from the terminal `:start`/`:end` suffix, so a colon-bearing marker can no longer bypass the mismatch scanner and let a start pair with a later end. A marker line with no parseable name now refuses the note. Marker discovery, marker replacement, heading replacement, and marker insertion all track fenced code blocks, so a fenced `## Section` example or a fenced marker pair is never published over or inserted into. Part of #1985.
