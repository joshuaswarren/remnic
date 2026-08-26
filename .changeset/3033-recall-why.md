---
"@remnic/core": minor
"@remnic/cli": minor
---

feat: `remnic why` — diagnose why a memory was NOT recalled (#3033)

`xray` explains the results a recall returned; nothing explained an absence. `why` replays the real recall once and attributes the outcome to pipeline stages in contract order (retrieval -> policy filters -> rerank -> cap -> format), with per-drop reasons: planner mode, namespace scope, status filter, path exclusion, score floor, cap eviction, backend failure.

`--expect <memory-id|substring>` traces one memory and names the exact stage that dropped it plus a remediation hint. A search backend that fails before or during the diagnosis reports `backend_unavailable` rather than an empty pipeline. Read-only, and not gated behind `recallDirectAnswerEnabled`.

Surfaces: `remnic why` (local and remote-daemon), MCP `engram.recall_why` / `remnic.recall_why`, HTTP `GET /engram/v1/recall/why`, and `EngramAccessService.recallWhy()`.

Recall gains one optional out-parameter, `RecallInvocationOptions.degradationSink`, which collects the backend degradations a recall already observed. It is absent by default, so recall behavior is unchanged.
