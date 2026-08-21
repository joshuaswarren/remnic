---
"@remnic/core": patch
---

Add a default-off `episodicContextEnabled` flag that injects a `## Source Episodes` recall section: the structured `sources` provenance of the top recalled facts is resolved to LCM archive turn ranges, overlapping ranges in one session merge into episodes, and up to 2 episodes of cleaned raw user/assistant turns (8 turns each, 2400 chars total) are appended within the existing recall budget and enrichment deadline. Facts without a structured `sources` array are skipped; no LLM calls and no new storage. Closes #2331.
