---
"@remnic/server": patch
---

Document and regression-test that standalone daemon config accepts top-level `searchBackend` / `qmdEnabled` as aliases of `remnic.*`, with the nested block winning on conflict.

Stability: stable
