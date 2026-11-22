---
"@remnic/core": patch
Stability: stable
---

Operator-aware semantic consolidation now supports SPLIT end to end. The prompt asks a SPLIT for an `outputs` array, the parser keeps every non-empty output, and the coordinator writes one canonical memory per output with shared lineage, then archives the sources against all of them. Before this change a SPLIT that returned `outputs` was stored as one memory holding the raw JSON reply. MERGE and UPDATE still write exactly one memory. Refs #3566.
