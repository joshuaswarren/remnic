---
"@remnic/core": patch
---

Fix namespace allow-list bypass on id-loaded contradiction routes (#1850).
The contradiction detail GET (`/review/contradictions/:pairId`) and the
review/resolve mutate route loaded the pair BY ID, so the pair's namespace
came from the record — not a `?namespace=` query param that `resolveNamespace`
already gates. A namespace-scoped bearer that knew a pair id could therefore
READ (and, via review/resolve, MUTATE) contradiction data in a namespace
outside its allow-list. Both routes now assert the loaded pair's namespace
against the presenting token's capability allow-list (`assertNamespaceAllowed`)
and fail closed (403) before any read or mutation. The contradiction-review
and resolution modules were also hoisted to static top-level imports.
