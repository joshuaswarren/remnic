---
"@remnic/core": patch
---

Google Drive connector credentials now accept a SecretRef and resolve it at poll time through the host resolver. The three plugin manifests allow a SecretRef for the Drive client id, client secret and refresh token, and `remnic connectors run` passes the host resolver. A plain string still works. A SecretRef with no resolver fails that connector only, and a resolved value is never written to the state file or to a log.

Stability: stable
