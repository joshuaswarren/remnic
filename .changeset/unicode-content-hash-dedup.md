---
"@remnic/core": patch
---

Preserve Unicode letters, marks, and numbers in content hashes and statement deduplication. Normalize hashes to NFC and version the persisted hash index so legacy entries cannot suppress writes after the normalization change (#2186).
