---
"@remnic/core": patch
---

Entity recall no longer normalizes and tokenizes the whole query again for every alias of every entity. The query is prepared once per recall (and once per recent turn), then each alias is scored against it. A live CPU profile showed `buildEntityRecallSection` holding the server main thread for 1.4 s per recall in `scoreAliasMatch` and `normalizeEntityText`; the cost grew with entities times query length. Scores and matches do not change. New test: 1,500 entities and a 130 KB query took 22.2 s before the change and finishes under the 1.5 s limit after it.

Stability: no behavior change; same scores and same recalled entities, less CPU per recall.
