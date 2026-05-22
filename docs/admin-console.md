# Remnic Admin Console

Local operator surface served by `remnic access http-serve` at
`/remnic/ui` (and the legacy `/engram/ui` alias). All data fetches and
operator actions go through the loopback bearer-token API; the page
itself is a static `index.html` + `app.js` shell shipped under
`admin-console/public/`.

## Panes

- **Memory Browser** — paginated list of `/engram/v1/memories` with
  query / status / category / sort filters.
- **Memory Detail** — content + timeline for a selected memory, with
  raw-path copy. Memory detail is the operator home for "why did you
  remember this?", "forget this", "correct this", and "scope this"
  actions as those controls graduate from API/CLI surfaces.
- **Recall Debugger** — runs `/engram/v1/recall` and
  `/engram/v1/recall/explain` for a session key. Pair it with Recall
  X-ray when auditing per-result provenance, stale/correction state,
  and whether a memory is safe to use in the current context.
- **Quality Dashboard** — counts + latest governance run from
  `/engram/v1/quality`.
- **Trust Zones** — browse and (optionally) promote trust-zone
  records.
- **Review Queue** — governance review queue with confirm / reject /
  archive dispositions.
- **Entity Explorer** — search and inspect entities.
- **Memory Graph** — live force-directed view of the multi-graph
  adjacency from `GET /engram/v1/graph/snapshot` plus incremental
  updates from `GET /engram/v1/graph/events` (issue #691).
- **Maintenance** — JSON dump of the current maintenance summary.

## Memory Graph pane (#691 PR 3/5)

The graph pane fetches a read-only baseline snapshot from
`GET /engram/v1/graph/snapshot` and renders it with a small vanilla
force-directed simulation (no new runtime dependencies). After the
snapshot loads, the pane opens an SSE stream at
`GET /engram/v1/graph/events` and applies incremental node/edge
mutations in memory so new graph changes appear without a full
re-fetch. The **Refresh** control still re-fetches the baseline snapshot
and restarts the stream.

Controls:

- **Limit** — caps the number of edges fetched (100 / 250 / 500 /
  1000). The endpoint enforces a server-side maximum of 5000.
- **Focus Node Id** — forwards as `focusNodeId` so the snapshot is
  restricted to the focus node and its direct neighbors.
- **Refresh** — re-fetches and re-renders.
- **Reset View** — clears any pan / zoom transform.

Interactions:

- **Pan** — click and drag the canvas.
- **Zoom** — scroll-wheel over the canvas.
- **Node tooltip** — hover a node to see its memory id, category,
  aggregate score, and last-updated timestamp.
- **Edge tooltip** — hover an edge to see its kind (entity / time /
  causal) and confidence (0–1).
- **Color coding** — nodes are colored by category; the legend below
  the canvas surfaces the category → color mapping.

Operator notes:

- The pane only renders after the bearer token connects successfully;
  the snapshot endpoint requires the same loopback auth as every
  other admin call.
- The first fetch runs automatically as part of the connect bootstrap
  alongside the other panes.
- Empty snapshots render an inline placeholder rather than failing.
