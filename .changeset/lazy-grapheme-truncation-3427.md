---
"@remnic/core": patch
---

Stability: stable

`truncateGraphemeSafe` now stops segmenting once its budget is reached instead of splitting the whole string into grapheme clusters first (#3427). The output is unchanged. For a short budget, such as the 180-unit truncation in entity mention indexing, it no longer builds or walks every grapheme cluster of a long fact. The segmenter still takes the whole string, so a small cost that grows with the input length remains.
