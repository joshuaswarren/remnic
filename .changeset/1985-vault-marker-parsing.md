---
"@remnic/core": minor
---

Reject `:` in managed-region names and parse marker names from the terminal `:start`/`:end` suffix, so a colon-bearing marker can no longer bypass the mismatch scanner and let a start pair with a later end. A marker line with no parseable name now refuses the note. The heading strategy also tracks fenced code blocks, so a fenced `## Section` example is never treated as the owned heading. Part of #1985.
