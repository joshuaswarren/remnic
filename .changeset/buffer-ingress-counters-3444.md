---
"@remnic/core": minor
---

Count turn ingress at the extraction-buffer add per outcome — accepted, deduplicated, filtered, refused — in turns and characters. Counters are process-local and instance-owned, feed a 24-hour hourly ring with ONE aggregate info line per hour (counts only; no content, no session ids), and surface as a read-only top-level `bufferIngress` field on `/engram/v1/health` (deliberately outside `extraction`). Behavior changes at the add path: an identical re-offer of an already-buffered or already-offered turn (same content and capture scope/provenance) is skipped and counted `deduplicated` instead of being buffered twice, and empty or whitespace-only offers are dropped and counted `filtered`. Closes #3444.
