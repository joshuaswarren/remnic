---
"@remnic/core": patch
---

Buffer drain claims preserve duplicate turn occurrences and keep cross-list identities pending when extraction progress cannot prove which source occurrence remains. Lease operations verify owner ID, process ID, and host under the claim lock.

Stability: stable
