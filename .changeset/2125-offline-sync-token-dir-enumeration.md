---
"@remnic/core": patch
---

Fix offline-sync root snapshot-stream 500 (`unsafe namespace`) on canonical token directories. `listOfflineSyncNamespaces` now decodes `ns-<hex>` canonical token dirs back to their namespace name (matching the catalog rebuild scanner) and skips any filesystem-derived name the router would reject, so a namespace stored in a token dir whose basename exceeds the 64-char `isSafeRouteNamespace` cap (e.g. a `project-origin-<hash>` scope) no longer aborts the whole `GET /remnic/v1/offline-sync/snapshot-stream`. The root-snapshot lifecycle-drain fanout also degrades to draining the remaining namespaces instead of failing the snapshot when one namespace cannot be resolved. Part of #2125.
