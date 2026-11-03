---
"@remnic/core": patch
---

Stability: stable

Tell QMD maintenance when the namespace catalog could not be read whole. `NamespaceCatalog.listNamespaces()` still returns every record it could read, and now takes an optional `onIncomplete` callback that reports an unreadable catalog file or malformed rows that were skipped (a catalog that was never written is normal and is not reported). The namespace planner records `catalog_read_failed` for such a read and still plans the namespaces it found, so the entity migration keeps its pending re-index marker instead of clearing it after a pass that missed cataloged namespaces. Other catalog consumers are unchanged. Fixes #3293.
