---
"@remnic/core": patch
Stability: stable
---

Binary lifecycle scan patterns now match as case-insensitive globs: `*` matches any run of characters and `?` one character anywhere in the filename, so patterns such as `img_*.jpg` or `scan-??.png` find their files instead of matching nothing. `*.ext` and exact names behave as before. Refs #3549.
