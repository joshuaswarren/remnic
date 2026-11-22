---
"@remnic/bench": patch
---

Wire the bench exploit audit's contamination mirror test through the shared
manifest path: the synthetic dirty-hash entry is merged via
`addContaminationEntry(EMPTY_CONTAMINATION_MANIFEST, …)` instead of a
hand-rolled literal kept alive by a `void` placeholder (issue #3615).
