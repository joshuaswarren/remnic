---
"@remnic/core": patch
---

Order projected harmonic sources newest-first using the per-source insertion timestamps already stored on abstraction nodes, so projected titles and summaries describe the most recently inserted facts instead of the three oldest. Equal or missing timestamps keep the previous ascending id order.
