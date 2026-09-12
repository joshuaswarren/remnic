---
"@remnic/core": patch
---

Stability: stable

Fix autoPromote never firing for HTTP/MCP `observe` (issue #3051). The observe
write surface resolved `scopeProfilePlan` but only forwarded
`writeNamespaceOverride` and `principalOverride` to `ingestReplayBatch`, so
`runExtraction` saw an explicit write namespace with no plan and every
promotion gate returned false. Observe now forwards
`scopeProfileWritePlan: scope.scopeProfilePlan` (mirroring force-flush), and
`ingestReplayBatch` accepts and forwards it to `queueBufferedExtraction`.
Namespaces-disabled single-store behavior is unchanged (plan omitted).
