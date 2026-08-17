---
"@remnic/cli": patch
---

Honor REMNIC_DAEMON_URL / server.url as a full https origin for remnic status, query, doctor, and xray so a hosted Remnic is not silently replaced by localhost:4318.
