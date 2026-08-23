---
"@remnic/core": minor
---

State-aware recall views (issue #1952), now wired end to end. `recallStateViews` (default `false`, exact `false`/`0`/`"false"` disable) is parsed by `parseConfig`. On change-intent queries ("when did", "used to", "switched", "changed" + conjugations), the recall policy-filter stage admits a superseded memory only when its successor is also in the candidate set (QMD, embedding-fallback, recent-scan, and cold-fallback paths), labels rows `current`/`historical`/`transition`, and renders historical rows with a `[superseded <date> by <id>]` prefix. A superseded row never renders without its successor (post-cap orphan fixpoint); flag off or non-change queries keep recall output byte-identical. The MCP `recall` tool accepts a per-call `stateView` boolean, and recall X-ray results expose the per-row label. `@remnic/bench` ships a deterministic LTP-style state-confusion task set (`benchmarks/remnic/retrieval-state-views`) with baseline-vs-enabled assertions.
