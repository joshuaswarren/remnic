# Theory: Localized and Path-Aware Conflict Recall

## Problem

Remnic has the structure needed for precise conflict recall, but two decision paths ignore part of it.

Contradiction checks used only a small text-search result set. They could miss a low-overlap fact for the same entity and category.

Graph recall scores reached nodes without checking the supporting path. A valid candidate can receive full support through stale evidence.

## Operating theory

Candidate discovery and decision authority must remain separate.

Issue #2327 uses `entityRef`, category, and structured attributes to find likely conflicts. The existing LLM verifier still makes the contradiction decision.

Issue #2328 uses the existing graph path as evidence. It demotes a candidate when an intermediate memory is inactive or temporally invalid.

Both changes must remain bounded and reversible. Disabled gates must preserve current behavior and avoid extra search, path, or corpus work.

## Current strategy

Issue #2327 localizes contradiction candidates with bounded entity and category anchors. It merges them with namespace-scoped QMD results.

The existing LLM verifier remains the decision authority. QMD unavailability emits a warning and keeps anchor candidates.

Issue #2328 records one seed-scoped activation path. It chooses fewer hops, stronger landing weight, then lexical path order.

The graph coordinator applies edge-confidence and intermediate-validity penalties before the namespace output cap. A bounded headroom cap limits state I/O.

Optional path fields extend existing snapshots and renderers. Disabled output omits them and uses the exact legacy path.

## Key discoveries

Current `main` contains issue #2326. This satisfies issue #2328's dependency.

Graph activation and path provenance need one winner rule. Equal-depth predecessor state must follow the strongest provenance winner.

Archived memories move away from their original graph path. Basename identity maps their state back to existing edges.

Historical recall already parses `asOf` once. Graph scoring must consume only the validated millisecond value.

The orchestrator graph-expansion method is an active test and override seam. Production recall must route through that seam.

Anchor snapshots must include hot and cold tiers. Each successful write or supersession must update the snapshot before the next batch item.

Cold candidates require cold-aware mutation paths. Detection without mutation parity leaves conflicting memories active.

Graph archive indexes reject symlinked roots. They use canonical roots, an archive-only generation, caller-local deadlines, and a 32-entry LRU.

Large archive scans publish an unavailable sentinel for that generation. This prevents repeated high-I/O scans until an archive mutation occurs.

Direct graph reads validate logical IDs. Active hot and cold copies use the same canonical merge rule as contradiction anchors.

Contradiction retirement treats a false mutation result as ambiguous until fresh hot and cold reads prove a lost race.

Only a readable active losing row can complete lost-race cleanup. Missing data and I/O failures preserve the anchor for retry.

The path scorer inspects only intermediate nodes. It ignores seed and candidate status because existing filters own those decisions.

Temporal invalidity follows `[valid_at, invalid_at)`. A node is invalid when `invalid_at <= asOf`.

Missing path data or node state keeps multiplier `1`. Unknown evidence does not become negative evidence.

Legacy memories without a status remain active for contradiction anchors. Explicit non-active states remain excluded.

## Verification state

The latest focused race and graph-loader run passes 51 tests. Core type checks, ratchets, and lifecycle coverage pass.

`preflight:quick` passes after the current-head corrections. `test:entity-hardening` passes 339 tests.

Historical recall now bypasses current-status filtering only for historically valid `superseded` candidates.

Anchor snapshot read failures fail open with an empty snapshot. Failure state stays scoped to one storage instance.

Independent graph and contradiction reviewers approved the current production behavior. Current-head CI is in progress.
