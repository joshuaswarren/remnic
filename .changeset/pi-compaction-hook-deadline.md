---
"@remnic/plugin-pi": patch
---

Bound the `session_before_compact` hook by one deadline. The hook made three daemon calls (LCM flush, token record, context checkpoint), each with the 60 s default timeout, while omp aborts a hook handler at about 30 s. When the daemon held the flush open (its extraction LLM was unreachable), every compaction hit the host timeout. The three calls now share a single `turnRequestTimeoutMs` deadline and none retries; a call that times out, or a call reached after the deadline, is skipped with a warning and Pi's compaction proceeds. `lcmCompactionFlush`, `lcmCompactionRecord` and `contextCheckpoint` accept optional `RequestOptions`.

Stability: stable
