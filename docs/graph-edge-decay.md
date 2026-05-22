# Graph Edge Confidence Decay

> Shipped in issue #681 (three PRs). PR 1/3 added the `confidence` schema
> field to `GraphEdge`. PR 2/3 wired the maintenance job that decays edges
> over time. PR 3/3 integrated confidence into the recall traversal path and
> added `--include-low-confidence` for diagnostic queries.

## Overview

Every edge in Remnic's graph stores carries an optional `confidence ∈ [0, 1]`
value. Newly written edges start at `1.0`. The maintenance job periodically
reduces confidence for edges that have not been reinforced recently. Edges that
remain below the configured floor are pruned from traversal, which focuses
recall on high-quality, actively reinforced connections.

## Model

Each edge stores two fields:

| Field | Type | Purpose |
|-------|------|---------|
| `confidence` | `number \| undefined` | Current trust level in `[0, 1]`. Missing means `1.0` (legacy). |
| `lastReinforcedAt` | `string \| undefined` | ISO timestamp of the most recent reinforcement event. Missing means "never reinforced since write". |

Confidence decreases at a fixed fractional rate per **decay window** that has
elapsed since `lastReinforcedAt`. Edges that span multiple windows are charged
for all elapsed windows in a single pass, so the job is idempotent — running it
twice with the same timestamp is a no-op.

When an edge is observed during extraction (e.g., two memories share a named
entity), the reinforcement primitive resets `lastReinforcedAt` to `now` and
bumps `confidence` by the default reinforcement delta (`0.05`), capped at
`1.0`. Repeated co-occurrence can recover confidence that previously decayed,
but it cannot push an edge above the confidence ceiling.

**Confidence floor** — edges whose confidence drops to or below the configured
`graphEdgeDecayFloor` are never decayed further. They remain in the graph but
will be pruned during recall traversal unless `--include-low-confidence` is
specified.

## Maintenance Job

The decay job runs on a configurable cadence and processes all three graph
stores (`entity.jsonl`, `time.jsonl`, `causal.jsonl`).

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `graphEdgeDecayEnabled` | `false` | Enable the decay maintenance job. Set to `true` to activate decay. |
| `graphEdgeDecayCadenceMs` | `604800000` (7 days) | How often the job runs, in milliseconds. Minimum `60000`. |
| `graphEdgeDecayWindowMs` | `7776000000` (90 days) | Length of one decay window, in milliseconds. One window of inactivity loses `graphEdgeDecayPerWindow` of confidence. Minimum `60000`. |
| `graphEdgeDecayPerWindow` | `0.1` | Fraction of confidence lost per elapsed window. Range `[0, 1]`. |
| `graphEdgeDecayFloor` | `0.1` | Minimum confidence an edge can decay to; decay stops here. Range `[0, 1]`. |

### Tuning Guidance

- **Aggressive decay** (high-churn environments): lower `graphEdgeDecayWindowMs`
  to `30d` and raise `graphEdgeDecayPerWindow` to `0.2`–`0.3`. Edges that are
  not reinforced within a month will lose confidence quickly, keeping the graph
  lean.

- **Conservative decay** (stable long-term knowledge): raise
  `graphEdgeDecayWindowMs` to `180d` and lower `graphEdgeDecayPerWindow` to
  `0.05`. Edges survive six months of inactivity before losing significant
  confidence.

- **Disable decay**: set `graphEdgeDecayEnabled` to `false` (the default). All
  edges remain at their initial confidence for the lifetime of the graph.

- **Raise the floor**: increasing `graphEdgeDecayFloor` keeps old edges visible
  during traversal even without reinforcement. Lowering it to `0.0` allows edges
  to decay to zero and be effectively invisible unless `--include-low-confidence`
  is passed.

### Telemetry

Each run writes a JSON status file to
`<memoryDir>/state/graph-edge-decay-status.json` with the following fields:

```json
{
  "ranAt": "2026-04-27T00:00:00.000Z",
  "durationMs": 123,
  "edgesTotal": 4200,
  "edgesDecayed": 311,
  "edgesBelowVisibilityThreshold": 48,
  "topDecayedEntities": [
    { "label": "SomeEntity", "totalDrop": 0.3, "edgeCount": 3 }
  ],
  "perType": [
    { "type": "entity", "edgesTotal": 2100, "edgesDecayed": 200, "edgesBelowVisibilityThreshold": 30 },
    { "type": "time",   "edgesTotal": 1800, "edgesDecayed": 100, "edgesBelowVisibilityThreshold": 15 },
    { "type": "causal", "edgesTotal": 300,  "edgesDecayed":  11, "edgesBelowVisibilityThreshold":  3 }
  ],
  "windowMs": 7776000000,
  "perWindow": 0.1,
  "floor": 0.1,
  "visibilityThreshold": 0.2
}
```

`remnic doctor` reads this file and surfaces the last run time and summary
stats in its health report.

## Recall Integration

### Confidence-Weighted Spreading Activation

During graph traversal, each edge's contribution to spreading activation is
multiplied by its `confidence`:

```
score += edge.weight × edge.confidence × decay^hop
```

Legacy edges without a `confidence` field are treated as `1.0`, so old graphs
work unchanged.

### Traversal Pruning

Edges with `confidence < graphTraversalConfidenceFloor` are excluded from the
adjacency index before BFS begins. Pruned edges contribute no activation and
cannot serve as intermediate hops to deeper neighbors.

| Setting | Default | Description |
|---------|---------|-------------|
| `graphTraversalConfidenceFloor` | `0.2` | Minimum confidence required for traversal. Range `[0, 1]`. Legacy edges (no `confidence` field) are always `1.0`. |
| `graphTraversalPageRankIterations` | `8` | PageRank refinement iterations on top of BFS. Set `0` to use raw BFS scores. |

### The `--include-low-confidence` Flag

By default, recall traversal respects `graphTraversalConfidenceFloor` and
ignores decayed edges. Pass `--include-low-confidence` to a `remnic recall`
command to override this and include all edges regardless of confidence:

```bash
# Standard recall — low-confidence edges pruned
remnic recall "what do I know about authentication?"

# Diagnostic recall — all edges included even if heavily decayed
remnic recall "what do I know about authentication?" --include-low-confidence
```

This is an **operator / debug tool**, not a tuning knob. Use it when:

- You want to understand what edges exist before decay has cleared them.
- You suspect a recall is missing results because edges have decayed below
  the floor.
- You are auditing graph state before or after a decay maintenance run.

The flag threads through the full recall pipeline — both the
`expandResultsViaGraph` hot path and the `applyColdFallbackPipeline` cold path
respect it. It is also available via the HTTP API as a query parameter:

```
POST /engram/v1/recall
{ "query": "...", "includeLowConfidence": true }

# or as a query param:
POST /engram/v1/recall?include_low_confidence=true
{ "query": "..." }
```

## X-ray Surfacing

When recall X-ray capture is enabled (`remnic xray <query>`), each graph result
carries an `edgeConfidence` field in the per-result provenance. This is the
confidence of the highest-confidence edge along the BFS path that landed the
result. The `graphEdgeConfidences` array in the X-ray snapshot lists one entry
per edge in the recall path, aligned with `graphPath`.

Low-confidence results returned via `--include-low-confidence` will show
reduced `edgeConfidence` values in the X-ray, making it easy to distinguish
them from normally-admitted results.

## Cross-References

- [Graph Reasoning](architecture/graph-reasoning.md) — overall graph architecture,
  spreading activation model, PageRank refinement, lateral inhibition
- [Graph Dashboard](graph-dashboard.md) — live graph observability server
- [Config Reference](config-reference.md) — all `graphEdgeDecay*` and
  `graphTraversalConfidenceFloor` settings
