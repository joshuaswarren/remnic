---
"@remnic/bench": patch
---

Published-benchmark harness: emit an optional per-category aggregate breakdown (`results.categoryAggregates`) for benchmarks whose tasks stamp a `categoryName` detail — today only LoCoMo. This makes the adversarial-vs-answerable metric split issue #1878 tracks readable straight from the result artifact instead of hand-computed from task-id category suffixes. The `computeCategoryAggregates` helper groups finished task results by `categoryName` and reuses `aggregateTaskScores`; it reads only the category label (no oracle leak), sorts output keys for deterministic serialization, and is omitted when empty so other benchmarks' output shape is unchanged. Additive and provider-free — no change to recall, answering, scoring, or the abstention gate.
