---
"@remnic/core": patch
---

Stability: stable

`truncateGraphemeSafe` now stops segmenting once its budget is reached instead of splitting the whole string into grapheme clusters first (#3427). The output is unchanged. A 180-unit truncation of a long fact, as in entity mention indexing, no longer costs time in proportion to the fact's length.
