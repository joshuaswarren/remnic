---
"@remnic/core": patch
---

Stability: stable

Use scoped lexical search for new or repeated queries while an in-flight query that can embed or rerank on the same QMD daemon session is already slow. A pending lexical-only query with reranking disabled does not trigger this fallback (#3499).
