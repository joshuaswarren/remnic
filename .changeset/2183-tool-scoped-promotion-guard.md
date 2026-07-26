---
"@remnic/core": patch
---

Tool-scoped global-promotion guard (#2183). A fact that references a specific tool or command and was produced by a known integration (`sourceConnector`) is no longer promoted to the shared namespace by ANY path — a different integration exposing a same-named but incompatible tool (Pi `search` = repo code search vs OpenClaw `search` = web search) would otherwise consume it.

Detection is a pure predicate `referencesAgentSpecificTool` (bounded, backtracking-safe regexes). The tool-scope decision has exactly ONE definition — `withholdToolScopedFromSharedNamespace({ content, sourceConnector })` — consulted by every shared-namespace promotion path:
- `shouldPromoteGlobalFactToShared` (composed from the primitive) gates BOTH the pre-judge namespace prediction and the write-loop scope-routing block, so the read path and write path agree on the target namespace;
- the primitive itself gates the post-write `promoteMemoryToShared` (covering both the chunked and non-chunked call sites by construction), so `autoPromoteToSharedEnabled` and serverShared scope-profile targets can no longer re-leak a tool-scoped fact into shared.

No separate config knob: the guard is gated by the existing `extractionScopeClassificationEnabled` capability (the scope-routing block it lives in) for the scope-routing path; the auto-promote guard is structural. Unattributed or portable facts, and the disabled-capability case, are byte-identical to before.
