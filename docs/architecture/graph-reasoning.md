# Graph Reasoning

Remnic's graph layer is opt-in. It adds explicit graph storage plus bounded traversal on top of the normal recall pipeline; it does not replace the standard retrieval contract.

## Runtime Shape

The shipped graph stack is split into three parts:

1. `multiGraphMemoryEnabled` writes entity, time, and causal edges into the graph store.
2. `graphRecallEnabled` allows the planner to escalate into `graph_mode`.
3. `graphAssistInFullModeEnabled` runs bounded graph expansion during normal `full` recall when enough seed results exist.

The planner still follows the same high-level order:

1. retrieve candidate headroom
2. apply policy filters
3. rerank / graph-assist blend
4. cap to the user-facing budget
5. format and inject

## Core Controls

Use these knobs to bound graph work:

| Setting | Purpose |
|---------|---------|
| `maxGraphTraversalSteps` | Hard ceiling on traversal hops |
| `graphRecallMaxSeedNodes` | Maximum initial seed nodes |
| `graphRecallMaxExpandedNodes` | Maximum expanded nodes kept in one pass |
| `graphRecallMinSeedScore` | Minimum seed quality before traversal begins |
| `graphAssistMinSeedResults` | Minimum non-graph seed results before assist runs in `full` mode |
| `graphTraversalConfidenceFloor` | Minimum edge confidence required for traversal (default `0.2`, range `[0, 1]`). Edges below this floor are pruned and contribute neither activation nor downstream neighbors. Legacy edges without a `confidence` field are treated as `1.0` and always pass. |
| `graphTraversalPageRankIterations` | Number of PageRank-style refinement iterations applied on top of the BFS spreading-activation scores (default `8`, minimum `0`). Each iteration redistributes a node's confidence-weighted activation along its outgoing edges. Set to `0` to disable refinement and use raw BFS scores. |

### Confidence-aware traversal (issue #681)

Graph edges carry an optional `confidence ∈ [0, 1]` field that is reinforced
on observation (PR 1/3) and decayed by the maintenance job (PR 2/3). PR 3/3
wires that confidence into the recall path:

1. **Weighting** — each edge contributes `weight × confidence × decay^hop` to
   spreading activation, so a half-trust edge contributes half the activation
   of a full-trust edge at the same hop depth.
2. **Pruning** — edges with `confidence < graphTraversalConfidenceFloor` are
   dropped from the adjacency index before BFS, so they never seed activation
   and never serve as a hop to deeper neighbors. Pruning is symmetric across
   bidirectional entity/time edges and one-way causal edges.
3. **PageRank refinement** — when
   `graphTraversalPageRankIterations > 0`, an iterative pass redistributes
   each node's activation along its confidence-weighted outgoing edges
   (damping fixed at the canonical `0.85`). Refinement only redistributes
   among nodes BFS already discovered — it sharpens ranking, it does not
   relax floor-pruned edges.
4. **X-ray surfacing** — the strongest edge confidence along each candidate's
   chosen entry path is recorded in provenance, propagated through
   `GraphRecallExpandedEntry.edgeConfidence`, and surfaced in the
   recall-explain text block (`conf=0.87`) and the per-result X-ray
   `graphEdgeConfidences` array (one entry per edge, aligned with
   `graphPath`).

Operators dial this in by adjusting the floor (`0` admits every edge,
matching pre-#681 behavior; higher values increase precision at the cost of
recall) and the iteration count (`0` falls back to raw BFS scores).

These are the operator-facing differences between the two graph paths:

| Path | What it changes |
|------|-----------------|
| `graph_mode` | Planner explicitly chooses graph expansion as the recall mode |
| `graphAssistInFullModeEnabled` | Keeps `full` recall as the primary mode and blends graph expansions into it when the seed set is strong enough |

## Explainability and Shadowing

The graph stack is meant to be observable before it is trusted:

- `graphRecallShadowEnabled` keeps graph recall on a telemetry path.
- `graphRecallSnapshotEnabled` writes bounded snapshots under `state/graph/`.
- `graphRecallExplainEnabled` and `graphRecallExplainToolEnabled` expose graph path explanations.
- `graphAssistShadowEvalEnabled` computes the assist path for comparison without changing injected recall output.

## Operational Guidance

- Start with `memoryOsPreset: "balanced"` if you want indexing and artifacts without graph expansion.
- Move to `memoryOsPreset: "research-max"` when you want the broadest shipped graph + learning surface.
- Keep `maxGraphTraversalSteps` small at first. The default `3` is deliberate.
- If graph recall quality regresses, disable `graphRecallEnabled` first, then `multiGraphMemoryEnabled` if you need to stop graph writes entirely.

## Historical Context

Historical v8 plan files describe broader graph ambitions and research rationale. Treat those files as design context only. The GitHub Project and the live config surface are the source of truth for what is currently expected to ship and how operators should enable it.
