---
"@remnic/core": patch
---

Fix namespace allow-list bypass on HTTP routes (#1850). Per-token namespace
scoping was enforced only for EXPLICIT namespaces in `resolveNamespace`, and
many GET handlers (memory_list, memory_get, entity_list, review-queue,
maintenance, quality, trust-zones, console/state, dreams/status, graph events,
correction/pending, contradiction-scan, dreams/run) passed `?namespace=`
straight to the service without calling the enforcing helper. A scoped bearer
could therefore OMIT the parameter and silently reach the server default tenant.
`resolveNamespace` now treats the EFFECTIVE namespace (explicit OR the server
default when omitted) as the value to authorize and fails closed when it is not
a member of the token's allow-list, and every namespace-scoped route now routes
through it so omission can no longer reach an unlisted default.
