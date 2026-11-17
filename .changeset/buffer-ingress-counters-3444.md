---
"@remnic/core": minor
---

Observe turn ingress at the extraction-buffer add (issue #3444): a new process-local, instance-owned counter class records per outcome in turns and characters — `accepted` (appended; includes the observational sub-count `acceptedExactDuplicate` for appended turns whose role+content exactly match a turn already in that session's entry, giving #3443 its true duplicate rate), `refused` (existing capacity-refusal paths), and `filtered` (structurally 0 at this layer; upstream pre-buffer filters live outside the add path). Feeds a 24-hour hourly ring with ONE aggregate info line per hour (counts only; no content, no session ids) and a read-only top-level `bufferIngress` field on `/engram/v1/health`. Purely observational: buffering behavior is byte-for-byte unchanged (pinned by a counters-on vs counters-disabled differential test). A per-entry sha256 digest set (no content retained, FIFO-capped at 4096 digests; beyond the cap the oldest unique contents stop being recognized, an under-count only) tracks duplicates.

Stability: stable
