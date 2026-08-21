---
"@remnic/core": patch
---

Cross-lingual recall: stamp a dominant-script hint (ISO 15924, e.g. `latn`/`jpan`) into memory frontmatter `language` at write time, and teach the recall planner to compare the query's script against the corpus's. On a mismatch the lexical page is supplemented with vector-tier hits regardless of lexical fill, so an English query can retrieve a Japanese memory (and the reverse) when a multilingual embedding model is configured. When the scripts differ and no vector tier exists, recall records a `vector_tier_unavailable` degradation on the snapshot instead of returning an unexplained empty result. Legacy memories without the `language` field are tolerated — they simply do not vote for the corpus script. Closes #2197.
