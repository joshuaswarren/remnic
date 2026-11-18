---
"remnic-core": patch
---

perf(recall): R4 recall-scoped QMD search cache; R5 deliverable-gated hybrid top-up (#w91). Skips redundant second hybrid QMD search when the namespace-deliverable page is already full, cutting duplicate search/rerank work on warm recall.
