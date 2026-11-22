---
"@remnic/core": patch
Stability: stable
---

`disclosure: "raw"` recalls now attribute LCM transcript excerpts per result via each memory's provenance quotes (`sources[].quote`) instead of attaching the whole set to the first result. Excerpts no result claims stay anchored to the first result, memories without provenance quotes claim nothing, and the excerpt fanout cap is unchanged. Refs #3546.
