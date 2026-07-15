# Retrieval explain (tier explain)

After a recall, Remnic can tell you **which retrieval tier would have served
the query** — `direct-answer`, `hybrid`, and so on — plus the filters that
narrowed the candidate set. This annotation is called *tier explain*, and it
rides on the caller's last-recall snapshot.

> **Not to be confused with the graph-path `recall/explain` surface.** Two
> adjacent surfaces have similar names. This page documents the **tier
> annotation** (issue #518). The separately-shipped graph-path explainer
> answers "why did the graph subsystem return these memories?" and lives at
> `POST /engram/v1/recall/explain` / the `remnic.recall_explain` MCP tool. The
> [distinction table](#two-surfaces-with-similar-names) below spells out which
> is which. Tier explain is also the block carried inside a
> [Recall X-ray](./xray.md) snapshot.

## Enable it

Tier explain is gated behind the direct-answer retrieval tier, which is
**off by default**. Opt in with a single flag:

```jsonc
// plugins.entries.openclaw-remnic.config (or the top-level `remnic` block of a
// standalone remnic.config.json). Legacy plugin key: openclaw-engram.
{
  "recallDirectAnswerEnabled": true
}
```

`recallDirectAnswerEnabled` defaults to `false` (verified in
`packages/remnic-core/src/config.ts`). When it is `false`, `tierExplain` is
never populated and all three surfaces below report "not populated".

## How it works

When `recallDirectAnswerEnabled` is `true`, the orchestrator runs a lightweight
direct-answer eligibility gate **in observation mode** alongside the normal QMD
retrieval path (`packages/remnic-core/src/orchestration/recall-introspection.ts`).
It records *which tier would have served the query* onto the calling session's
`LastRecallSnapshot.tierExplain` field
(`packages/remnic-core/src/recall-state.ts`) — it does **not** short-circuit
QMD or change which memories are returned. A future slice will flip the
short-circuit bit so the direct-answer winner can be returned before QMD runs;
until then this is a pure observability annotation.

The recorded shape is `RecallTierExplain` (`packages/remnic-core/src/types.ts`):

```ts
interface RecallTierExplain {
  tier: "exact-cache" | "fuzzy-cache" | "direct-answer" | "hybrid" | "rerank-graph" | "agentic";
  tierReason: string;        // human-readable summary
  filteredBy: string[];      // filter labels that eliminated at least one candidate
  candidatesConsidered: number;
  latencyMs: number;
  sourceAnchors?: Array<{ path: string; lineRange?: [number, number] }>;
}
```

The current release populates `tier: "direct-answer"` (the observation-mode
verdict). Other tiers are reserved for later slices.

## Surfaces

All three surfaces read the same `LastRecallSnapshot.tierExplain` field and are
shipped in the current release.

### CLI (hosted)

```sh
openclaw engram recall-explain [--session <key>] [--format text|json]
```

- **`--session`** — look up a specific session. Omit to read the most recent
  snapshot across sessions.
- **`--format`** — `text` (default) or `json`. Any other value is rejected with
  a listed-options error rather than silently defaulting.

There is no standalone `remnic recall-explain` command; tier explain is exposed
through the OpenClaw-hosted CLI, the HTTP endpoint, and the MCP tool. Standalone
callers read the same data over HTTP/MCP, or inline via a
[Recall X-ray](./xray.md) capture (`remnic xray`).

Text output for a direct-answer hit:

```
=== Recall Explain ===
session: primary
recorded: 2026-04-19T17:30:00.000Z
namespace: default
source: direct-answer
sources-used: direct-answer
latency-ms: 8
memories: pm

--- tier explain ---
tier: direct-answer
reason: trusted decisions, unambiguous, token-overlap 0.86
candidates-considered: 4
latency-ms: 8
filtered-by: below-token-overlap-floor
source-anchors:
  - /memory/pm.md:10-14
```

When no direct-answer verdict has been recorded, the output shows the snapshot
metadata followed by
`tier-explain: (not populated — direct-answer tier disabled or did not fire)`.

### HTTP

```
GET /engram/v1/recall/tier-explain[?session=<key>][&namespace=<ns>]
```

Bearer auth, same as every other `/engram/v1/*` route. Returns JSON:

```json
{
  "hasExplain": true,
  "snapshotFound": true,
  "sessionKey": "primary",
  "recordedAt": "2026-04-19T17:30:00.000Z",
  "namespace": "default",
  "memoryIds": ["pm"],
  "source": "direct-answer",
  "sourcesUsed": ["direct-answer"],
  "latencyMs": 8,
  "tierExplain": {
    "tier": "direct-answer",
    "tierReason": "trusted decisions, unambiguous, token-overlap 0.86",
    "filteredBy": ["below-token-overlap-floor"],
    "candidatesConsidered": 4,
    "latencyMs": 8,
    "sourceAnchors": [{ "path": "/memory/pm.md", "lineRange": [10, 14] }]
  }
}
```

When no snapshot exists yet, `snapshotFound: false`, `hasExplain: false`, and
`tierExplain: null`.

### MCP

- `remnic.recall_tier_explain` (canonical) / `engram.recall_tier_explain`
  (legacy alias).
- Optional `sessionKey` and `namespace` arguments. Omit `sessionKey` to read the
  most recent snapshot.
- Returns the same payload as the HTTP endpoint.

## Two surfaces with similar names

| | Tier explain (this page, #518) | Graph-path recall/explain (#570-era) |
| --- | --- | --- |
| **Answers** | "Which retrieval tier would have served this query, and what filtered candidates out?" | "Why did the graph subsystem return these memories?" (graph-path explanation document) |
| **CLI** | `openclaw engram recall-explain` | (no dedicated CLI) |
| **HTTP** | `GET /engram/v1/recall/tier-explain` | `POST /engram/v1/recall/explain` |
| **MCP** | `remnic.recall_tier_explain` / `engram.recall_tier_explain` | `remnic.recall_explain` / `engram.recall_explain` |
| **Data source** | `LastRecallSnapshot.tierExplain` | `EngramAccessService.recallExplain()` graph traversal |

The confusing overlap is deliberate history, not a bug: the CLI verb is
`recall-explain` but it renders **tier** explain, while the `recall_explain`
MCP tool renders the **graph-path** explanation. When in doubt, match on the
route/tool name in the table above, not the word "explain".

## Reading the `filteredBy` list

Each label identifies a gate that eliminated at least one candidate on the way
to the verdict. They are emitted regardless of the final eligibility so
consumers can see the narrowing steps:

- `non-active-status` — a candidate's status wasn't `active`
- `not-trusted-zone` — a candidate's trust zone wasn't `trusted`
- `ineligible-taxonomy-bucket` — a candidate's taxonomy bucket wasn't in the allowlist
- `below-importance-floor` — a candidate's importance was below the floor AND it wasn't `user_confirmed`
- `entity-ref-mismatch` — the caller supplied `queryEntityRefs` and the candidate's `entityRef` wasn't in the set
- `below-token-overlap-floor` — a candidate's query-to-memory token overlap was below the floor

## Caveats

- `tierExplain` populates only when `recallDirectAnswerEnabled: true` and the
  direct-answer gate returns a concrete verdict. Off-by-default is intentional
  (least-privileged recall) — see [Advanced retrieval](./advanced-retrieval.md)
  for the eligibility ladder and the full `recallDirectAnswer*` config keys.
- The current release runs direct-answer in **observation mode**: recall
  latency is the full retrieval path *plus* the eligibility gate (bounded — a
  small corpus adds under ~10ms; larger corpora scale with memory count). The
  short-circuit that returns the direct-answer winner before QMD is not yet
  shipped.
- The `tierExplain` payload is deep-copied by the shared renderer, so clients
  can mutate their local copy without tearing the store.

## Related reading

- [Recall X-ray](./xray.md) — per-result attribution snapshot that carries this
  same `tierExplain` block inline (plus filters, score decomposition, and audit
  correlation).
- [Advanced retrieval](./advanced-retrieval.md) — the direct-answer tier's
  eligibility gate, sibling tiers, and current ship status.
- `packages/remnic-core/src/direct-answer.ts` — pure eligibility gate
  `isDirectAnswerEligible(...)`.
- `packages/remnic-core/src/direct-answer-wiring.ts` — source-agnostic
  `tryDirectAnswer(...)` binding invoked by the orchestrator in observation mode.
- `packages/remnic-core/src/types.ts` — `RecallTierExplain` interface.
