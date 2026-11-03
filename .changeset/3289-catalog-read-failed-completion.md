---
"@remnic/core": patch
---

Stability: stable

Keep the entity migration's search-maintenance request owed when a QMD namespace pass could not read the namespace catalog. The pass still maintains the configured namespaces, but cataloged namespaces were never discovered, so the pending marker now stays until a pass that read the catalog. Fixes #3289.
