---
"@remnic/core": patch
"@remnic/cli": patch
---

Stability: stable

Wait out a busy tombstone-blocked capture write lock with capped exponential backoff instead of giving up after three short probes. A lock that stays busy fails that one converge transfer and the rest of the cycle continues. The extended backoff applies to converge transfers; a capture with no converge lock options (the plain daemon, an inline capture) keeps the previous three-probe, 25ms behavior.
