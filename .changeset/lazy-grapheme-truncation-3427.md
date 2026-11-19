---
"@remnic/core": patch
---

Stability: stable

`truncateGraphemeSafe` stops segmenting once its budget is reached instead of splitting the whole string into grapheme clusters first (#3427).
