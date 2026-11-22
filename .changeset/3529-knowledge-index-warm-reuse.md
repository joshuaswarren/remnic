---
"@remnic/core": patch
---

Fix the knowledge-index cache so a warm second recall reuses the index instead of rebuilding the full entity corpus (issue #3529). Recall always passes explicit `maxEntities`/`maxChars`, and the cache was read and written only when both overrides were absent, so every recall paid the corpus read twice (measured on 2,000 entity files: warm recall 1,999–2,636 ms before, 0.05 ms after; the cold build is unchanged). The cache is now keyed on the resolved limits (capped at 8 entries per storage), mutations still invalidate every entry, and different limits never see each other's rows.
