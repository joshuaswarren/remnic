---
"@remnic/core": minor
---

Add an opt-in write-path novelty gate (issue #1953). Cosine local density scores each candidate ADD, NOOP, or UNCERTAIN before semantic dedup. `noveltyGateEnabled` defaults to false.
