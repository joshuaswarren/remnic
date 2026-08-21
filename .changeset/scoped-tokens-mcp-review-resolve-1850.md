---
"@remnic/core": patch
---

Close the MCP `review_resolve` namespace allow-list bypass (#1850 round 9).
The HTTP `review/resolve` route (and contradiction detail GET) load the
contradiction pair BY pairId and assert the pair's intrinsic namespace
against the presenting token's capability allow-list before any mutation.
But the boundary/batch `review_resolve` handler — reached by MCP
`tools/call` for both the canonical (`remnic.review_resolve`) and legacy
(`engram.review_resolve`) tool-name aliases — resolved by `pairId` only,
with no namespace gate. Because this tool's schema carries no `namespace`
property, the MCP-over-HTTP `toolAcceptsNamespace` chokepoint skips it, so
a namespace-scoped bearer that knew a pair id could mutate a contradiction
pair in an UNLISTED namespace via MCP. The handler now loads the pair,
runs the SAME shared `enforceNamespaceAllowList` chokepoint the HTTP route
uses (mapping `undefined` → server default so a scoped token whose
allow-list includes the default can still resolve a legacy pair), and fails
closed (EngramAccessForbiddenError) before dispatching the mutating
resolution. A class audit of every id-addressed mutating operation routed
through the boundary found no other id-loaded intrinsic-namespace bypass;
param-namespace ops are gated by the MCP-over-HTTP tools/call namespace
gate, and the remaining id-loaded op (`memory_feedback`) writes to a global
store with no namespace axis.
