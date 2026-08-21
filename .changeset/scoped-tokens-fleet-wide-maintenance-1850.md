---
"@remnic/core": patch
---

Close the fleet-wide maintenance namespace-escalation class (#1850 round 10).

A distinct escalation class from the id-addressed routes (round 9) and the
param-namespace ops (round 4): maintenance/governance operations that
inherently run ACROSS ALL namespaces — or against a single non-namespaced
global layer (compression guidelines, shared context, compounding) — carry no
`namespace` argument, so the MCP-over-HTTP `tools/call` effective-namespace
chokepoint (`toolAcceptsNamespace`) never applies. Without a guard, a bearer
scoped to ONE tenant could trigger maintenance that mutates state in EVERY
namespace when the op was permitted (privilege escalation). The primary case
was `graph_edge_decay_run`, which calls
`runGraphEdgeDecayMaintenanceAcrossNamespaces` and decays edges in every
discovered namespace root.

A new shared `assertFleetWideOperationAllowed` helper (in
`access-token-capabilities.ts`, reusing the EXISTING capability model via
`capabilityAllowsNamespace` — no new "all"/"*" scope concept) fails CLOSED for
any namespace-SCOPED token (namespaces axis present) and is a no-op for
unrestricted/legacy tokens (absent record or no namespaces axis), so cron and
internal callers that never bind a capability record are unaffected. The
check is wired into `defineOperation`'s run wrapper via a new `fleetWide:
true` spec flag, so it fires BEFORE the handler — no side effect on denial —
for every surface that dispatches through the boundary (MCP `tools/call` +
HTTP). Ops that carry a `namespace` argument (governance, dreams,
contradiction-scan, pattern-reinforcement, procedure-mining) are already gated
by the existing effective-namespace chokepoint and are unaffected.

Class audit of every mutating maintenance/governance op reachable via the
token boundary: eleven inherently fleet-wide/global ops with no namespace arg
are now flagged — `graph_edge_decay_run`, `memory_summarize_hourly`,
`conversation_index_update`, `live_connectors_run`, `continuity_audit_generate`,
`compression_guidelines_optimize`, `compression_guidelines_activate`,
`shared_context_cross_signals_run`, `shared_context_curate_daily`,
`compounding_weekly_synthesize`, `compounding_promote_candidate`. Read-only
ops (`peer_list`, `profiling_report`, `maintenance_status`, etc.) are exempt
(no mutation), and per-id / coordination-layer ops (`work_task`, `peer_set`,
`shared_context_write_output`) are out of this maintenance-sweep class.
