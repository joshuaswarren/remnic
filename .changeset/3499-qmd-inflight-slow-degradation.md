---
"@remnic/core": patch
---

Stability: stable

Use scoped lexical search for new or repeated queries while a hybrid or vector query on the same QMD daemon session is already slow. Idle sessions keep the hybrid plan (#3499).
