---
"@remnic/core": patch
---

Stability: beta

Surface extraction-LLM availability in the server health payload (`extraction.llmReachable`, `extraction.lastFailureReason`, `extraction.lastFailureAt`) and emit ERROR-level deduplicated events on extraction failure (`no_models`, LLM unreachable) so a silent week-long memory outage cannot recur. Fixes the force-flush `deadlineMs` semantics (was treated as absolute Unix epoch, causing instant `scope_resolution` rejection on live session keys). Closes #3140.
