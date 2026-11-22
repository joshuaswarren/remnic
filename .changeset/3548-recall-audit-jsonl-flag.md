---
"@remnic/core": patch
Stability: stable
---

New config flag `recallAuditLogEnabled` (default off) gates the access-surface audit JSONL log that was previously hard-disabled. When enabled, each recall appends its audit entry to `<memoryDir>/transcripts/<date>/<sessionKey>.jsonl` — the same writer `AccessAuditAdapter` already used, unchanged. The flag is independent of `recallAuditAnomalyDetectionEnabled`: detection alone still writes nothing to disk. Audit write failures remain non-fatal to recall. Refs #3548.
