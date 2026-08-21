---
"@remnic/core": patch
---

Preserve Unicode letters, marks, and numbers in content hashes and statement deduplication. Normalize hashes to NFC, version persisted hash indexes, and migrate legacy fact/tombstone identities so stale entries cannot suppress writes or allow retired memories to resurrect (#2186).
