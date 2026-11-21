---
"@remnic/core": patch
Stability: stable
---

A non-finite `trailingReceiptFailures()` result (NaN, Infinity) is treated like unreadable history: the receipt-failure gate stays closed and the run demotes to shadow, instead of being ignored and letting a restarted coordinator dispatch active. Follows up #3620. Refs #3560.
