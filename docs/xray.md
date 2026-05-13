# Recall X-ray

Issue [#570](https://github.com/joshuaswarren/remnic/issues/570) adds a
unified per-result attribution snapshot for recalls. After any recall,
an X-ray capture tells you **exactly why each memory surfaced** — which
retrieval tier served it, how its score decomposed, every filter it
passed (and the first filter that would have rejected it), any graph
path traversed, the audit-log entry id, memory provenance and safety
context, and the character budget the final payload consumed.

Most competitors treat retrieval as a black box. Remnic X-ray makes the
whole ladder legible in one snapshot that is rendered identically by
the CLI, HTTP, and MCP surfaces — so what an operator reads in a
terminal matches byte-for-byte what an agent reads over MCP.

## How to run

```sh
remnic xray "<query>" [--format json|text|markdown] [--budget N] [--namespace ns] [--out file]
```

CLI surface defined in
[`packages/remnic-core/src/cli.ts`](../packages/remnic-core/src/cli.ts)
(lines 4015-4076). The handler delegates to a shared
`EngramAccessService.recallXray(...)` so the CLI, HTTP, and MCP
surfaces share the same `xrayQueue` mutex and cannot race each other
(rules 40 and 47).

Flags:

- `<query>` (required, non-empty). Validated by `parseXrayCliOptions`
  in
  [`packages/remnic-core/src/recall-xray-cli.ts`](../packages/remnic-core/src/recall-xray-cli.ts)
  (lines 52-77) — an empty or missing query throws a listed-options
  error rather than silently defaulting.
- `--format` — `text` (default), `markdown`, or `json`. Unknown
  values raise an error that lists the valid options
  (`parseXrayFormat`, `recall-xray-renderer.ts` lines 40-52).
- `--budget <chars>` — positive integer override for the recall
  character budget on this single call. Not a positive integer →
  rejected at the CLI boundary (rules 14 and 51).
- `--namespace <ns>` — override the namespace to scope this recall
  against.
- `--out <path>` — write the rendered snapshot to a file instead of
  stdout. The path is tilde-expanded (rule 17).

### Sample output

The following is a synthetic example of a text-format X-ray for a
review-context-augmented recall. Exact field ordering and spacing are
stable under the renderer's golden tests (lines 93-139 of
`recall-xray-renderer.ts`).

```
=== Recall X-ray ===
query: what did we decide about the recall cache TTL
snapshot-id: 5f6b1a2c-9d8e-4c01-8f3a-1b2c3d4e5f60
captured-at: 2026-04-20T17:30:00.000Z
session: agent-session-42
namespace: alice-project-origin-ab12cd34
trace-id: trace-7c1f
budget: 5284 / 8192 chars

--- filters ---
- namespace-scope: 12/12 admitted
- status-active: 11/12 admitted (rejected superseded)
- trust-zone: 11/11 admitted
- token-overlap: 7/11 admitted (below-token-overlap-floor)
- mmr-diversify: 4/7 admitted
- budget-fit: 4/4 admitted

--- results ---
[1] decisions/recall-cache-ttl — served-by=direct-answer
    path: decisions/recall-cache-ttl.md
    score: final=0.8912 importance=0.6000 tier_prior=0.3000
    provenance: source=conversation created=2026-04-18T21:13:00.000Z scope=namespace:alice-project-origin-ab12cd34 confidence=0.94 stale=false corrected=false safe=true
    retrieval-reason: served-by=direct-answer
    context-scopes: repo, work
    admitted-by: namespace-scope, status-active, trust-zone, token-overlap
    audit-entry: audit-0e4a1b
[2] decisions/recall-cache-eviction — served-by=hybrid
    path: decisions/recall-cache-eviction.md
    score: final=0.7204 vector=0.5812 bm25=0.4733 mmr_penalty=0.0400
    provenance: source=conversation created=2026-03-28T14:02:00.000Z scope=namespace:alice-project-origin-ab12cd34 confidence=0.83 stale=true corrected=superseded safe=false
    retrieval-reason: served-by=hybrid
    safety: requires-review (status=superseded, stale=true)
    admitted-by: namespace-scope, status-active, trust-zone, token-overlap, mmr-diversify
    audit-entry: audit-0e4a1c
[3] notes/perf-regression-2026-03 — served-by=graph
    path: notes/perf-regression-2026-03.md
    score: final=0.6187 vector=0.4910 tier_prior=0.1500
    graph-path: recall-cache-ttl -> related-to -> perf-regression-2026-03
    edge-confidences: 0.87
    admitted-by: namespace-scope, status-active, trust-zone, mmr-diversify
    audit-entry: audit-0e4a1d
[4] notes/branch-observations — served-by=review-context
    path: notes/branch-observations.md
    score: final=0.5500 vector=0.3200 importance=0.3000
    admitted-by: namespace-scope, status-active, trust-zone, mmr-diversify
    rejected-by: below-token-overlap-floor
    audit-entry: audit-0e4a1e

--- tier explain ---
tier: direct-answer
reason: trusted decisions, unambiguous, token-overlap 0.86
candidates-considered: 4
latency-ms: 8
filtered-by: below-token-overlap-floor
source-anchors:
  - decisions/recall-cache-ttl.md:10-14
```

The markdown format is structurally identical but rendered as GitHub
tables + H2/H3 sections; the JSON format is the raw
`RecallXraySnapshot` serialized under a `{ snapshotFound: true, ... }`
envelope.

## JSON schema

The canonical v1 shape lives in
[`packages/remnic-core/src/recall-xray.ts`](../packages/remnic-core/src/recall-xray.ts).
A stable `schemaVersion: "1"` tag on every snapshot lets downstream
consumers version-gate their parsers.

### `RecallXraySnapshot`

```ts
interface RecallXraySnapshot {
  schemaVersion: "1";
  query: string;
  snapshotId: string;          // UUID minted per capture
  capturedAt: number;          // epoch ms
  tierExplain: RecallTierExplain | null;
  results: RecallXrayResult[];
  filters: RecallFilterTrace[];
  budget: { chars: number; used: number };  // non-negative ints
  sessionKey?: string;
  namespace?: string;
  traceId?: string;
}
```

### `RecallXrayResult`

```ts
interface RecallXrayResult {
  memoryId: string;
  path: string;
  servedBy:
    | "direct-answer"
    | "hybrid"
    | "graph"
    | "recent-scan"
    | "procedural"
    | "review-context";
  scoreDecomposition: RecallXrayScoreDecomposition;
  graphPath?: string[];
  graphEdgeConfidences?: number[]; // issue #681 PR 3/3 — aligned with graphPath
  auditEntryId?: string;
  admittedBy: string[];      // filters the candidate passed
  rejectedBy?: string;       // first filter that would have rejected
  provenance?: RetrievedMemoryProvenance;
}
```

### `RetrievedMemoryProvenance`

```ts
interface RetrievedMemoryProvenance {
  source: string;                 // where the memory came from
  created?: string;
  updated?: string;
  namespace?: string;
  scope: string;                  // concrete retrieval scope
  userContextScopes: UserContextScope[];
  retrievalReason: string;        // why this result surfaced now
  confidence: number;             // [0, 1]
  stale: boolean;
  corrected: boolean;
  correctionState: "none" | "correction" | "superseded" | "disputed" | "forgotten";
  safeToUse: boolean;
  safety: "safe" | "requires-review" | "blocked";
  safetyReasons: string[];
}
```

Provenance is built from memory frontmatter already loaded by the retrieval
ranking path. It records source, creation/update timestamps, namespace scope,
retrieval reason, confidence, stale/correction state, and whether the memory is
safe to use in the current context. User-aware scopes come from explicit
in-memory metadata when present and from existing scope tags such as `work`,
`repo`, `private`, or `do-not-use-outside-this-context`; the concrete namespace
still remains the always-present retrieval scope.

When the graph subsystem (`servedBy: "graph"`) produced a result, the X-ray
optionally surfaces a `graphEdgeConfidences` array aligned with `graphPath`:
each entry is the confidence of the edge between consecutive nodes, so the
array length is always `graphPath.length - 1`. Operators use this to
attribute floor-pruning and PageRank ranking decisions back to specific
edges. See [`graph-reasoning.md`](architecture/graph-reasoning.md) for the
underlying floor and iteration controls (`graphTraversalConfidenceFloor`,
`graphTraversalPageRankIterations`).

### `RecallXrayScoreDecomposition` (lines 68-75)

```ts
interface RecallXrayScoreDecomposition {
  vector?: number;
  bm25?: number;
  importance?: number;
  mmrPenalty?: number;
  tierPrior?: number;
  reinforcementBoost?: number;  // additive boost from reinforcement_count (issue #687 PR 3/4)
  final: number;             // the only guaranteed field
}
```

Different tiers populate different terms. `hybrid` typically reports
`vector` + `bm25` + `mmrPenalty`; `direct-answer` reports `importance`
+ `tierPrior`. When `reinforcementRecallBoostEnabled` is `true`, memories
with `reinforcement_count` frontmatter also carry `reinforcementBoost`.
The renderer formats each known field with four decimal places and keeps
the line stable across missing fields.

### `RecallFilterTrace` (lines 104-110)

```ts
interface RecallFilterTrace {
  name: string;
  considered: number;        // admitted + rejected
  admitted: number;
  reason?: string;           // human-readable rejection summary
}
```

The `servedBy` union is orthogonal to the `RetrievalTier` enum used by
issue #518's tier-explain surface. The two sets stay separate on
purpose so the observability contracts can evolve independently;
`tierExplain` is carried verbatim inside the X-ray snapshot when the
direct-answer tier ran.

## HTTP surface

```
GET /engram/v1/recall/xray?q=<query>[&session=<key>][&namespace=<ns>][&budget=<chars>]
```

Defined in
[`packages/remnic-core/src/access-http.ts`](../packages/remnic-core/src/access-http.ts)
(lines 403-477). The route is `GET` so proxies can cache the response
by full URL; all recall parameters are query-string fields. Bearer
auth is enforced identically to the rest of `/engram/v1/*`, and the
namespace is resolved through `resolveNamespace(...)` before the
orchestrator runs — the same scope layer the write path uses, so there
is no cross-namespace read leak (rule 42).

Content negotiation: the endpoint currently returns JSON
(`respondJson`). CLI and operator callers who want the markdown or
text rendering compute it locally via `renderXray(snapshot, format)`
from the shared renderer.

Validation errors surface as `400`s with an `error`/`code`/`message`
triple (missing query, invalid budget). Backend faults bubble to the
global `handle()` catch so they return `500` with a logged trace id.

## MCP tool

Registered as `engram.recall_xray` in
[`packages/remnic-core/src/access-mcp.ts`](../packages/remnic-core/src/access-mcp.ts)
(lines 180-207, handler at 1228-1280). `withToolAliases` emits
`remnic.recall_xray` as the canonical alias automatically — the
dual-name invariant that every new MCP tool ships with.

Input schema accepts `query` (required), `sessionKey`, `namespace`,
and `budget`. Validation errors are surfaced as MCP tool-call errors
listing the valid options instead of silently returning
`snapshotFound: false`.

Response shape matches the HTTP surface exactly:

```json
{
  "snapshotFound": true,
  "snapshot": { /* RecallXraySnapshot */ }
}
```

When the orchestrator does not produce a snapshot (capture disabled,
session scope mismatch), the response is `{ "snapshotFound": false }`.

## Legacy `/recall/explain` markdown delegation

Issue #518 introduced `recall/explain` with `text` and `json` formats
that surface a single-session tier snapshot. Issue #570 PR 7 adds a
`markdown` format to that same surface — and rather than duplicate the
rendering logic, the explain renderer delegates to the shared X-ray
markdown renderer when `format === "markdown"`. See
[`packages/remnic-core/src/recall-explain-renderer.ts`](../packages/remnic-core/src/recall-explain-renderer.ts)
(lines 29-35, 239-340).

This is backwards-compatible. Existing `text` and `json` callers see
no change — the markdown branch is additive. The adapter at
`toRecallXraySnapshotFromLegacy(...)` maps the
`LastRecallSnapshot` shape into the X-ray snapshot shape so the
renderer's single code path handles both surfaces (CLAUDE.md rule 22:
one renderer, not three).

The orthogonality from #518 is preserved: `recall/explain` still
returns a single-session snapshot; `recall/xray` captures a fresh
snapshot against an arbitrary query. They answer different questions
and live at different URLs.

## Observability positioning

Most memory / retrieval systems treat recall as a black box. You see
what the system returned; you do not see why, which filters it applied,
or how close a rejected candidate came to being admitted. X-ray makes
the retrieval ladder legible:

- **Per-result attribution** — every returned memory carries its
  `servedBy` tier, score decomposition, and the ordered list of
  filters it passed, with the first rejecting filter tracked even for
  admitted results (when one exists).
- **Filter ladder** — the snapshot records every gate the orchestrator
  ran with `considered` and `admitted` counts, so you can see exactly
  where candidates are being dropped.
- **Budget accounting** — `budget.used` / `budget.chars` shows what
  fraction of the recall budget the final payload consumed, so
  over-long or too-sparse recalls are diagnosable without log diving.
- **Audit correlation** — each result carries an `auditEntryId` that
  cross-references the standard audit log; you can follow a recall
  from X-ray to the recall-audit trail to the storage operation.
- **Tier-explain inline** — when the direct-answer tier ran, its
  `RecallTierExplain` block is carried verbatim inside the snapshot
  so the filter ladder and the tier verdict live side by side.

For one-off investigations operators run `remnic xray "<query>"`. For
systemic observability they consume the MCP tool or HTTP endpoint and
stream snapshots into their own analytics pipeline — the JSON shape is
stable under `schemaVersion: "1"`.

## Related reading

- [Retrieval Explain](./retrieval-explain.md) — issue #518's
  single-session tier-explain surface. The `markdown` format there now
  delegates to the X-ray renderer.
- [Advanced Retrieval](./advanced-retrieval.md) — the tiers whose
  output X-ray attributes.
- [`packages/remnic-core/src/recall-xray.ts`](../packages/remnic-core/src/recall-xray.ts) — schema, builder, and pure factories.
- [`packages/remnic-core/src/recall-xray-renderer.ts`](../packages/remnic-core/src/recall-xray-renderer.ts) — shared text / markdown / JSON renderer used by CLI, HTTP, and MCP.
- [`packages/remnic-core/src/recall-xray-cli.ts`](../packages/remnic-core/src/recall-xray-cli.ts) — `--format` / `--budget` / `--namespace` / `--out` validation.
