---
"@remnic/core": patch
---

Google Drive connector credentials now accept a SecretRef and resolve it at poll time through the host resolver. A plain string still works with no resolver. A SecretRef with no resolver fails that connector only, and a resolved value is never written to the state file or to a log.

Stability: stable
