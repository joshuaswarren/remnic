---
"@remnic/core": minor
---

Add the budgeted deep-recall surface: a REFINE/EXPAND/STOP retrieval loop over the abstraction-node + cue-anchor graph, blended with seed search. Each iteration a prompted policy either rewrites the query, follows anchor-linked frontier nodes into the working set, or stops, under explicit `maxSteps` / `maxExpandPerStep` / `maxResults` / `stepTimeoutMs` / `totalTimeoutMs` budgets. This retrieves multi-hop answers that one-shot semantic search misses — a memory that shares a cue anchor with a matching memory is reachable even when its own text never matches the query.

Off by default behind `deepRecall.enabled`; documented `0` limits are honored (`maxSteps: 0` runs seed-only with no policy call, `maxResults: 0` returns an empty list). Exposed only on the deep surfaces — MCP `engram.deep_recall`, `POST /engram|remnic/v1/recall/deep`, and `remnic engram deep-recall <query>` — all delegating to one `EngramAccessService.deepRecall` implementation and one renderer. The recall hot path is untouched. Timeout or budget exhaustion returns the partial working set with a `BUDGET_EXHAUSTED` trace tail; only a seed-search backend failure returns `ok: false`. Closes #2332.
