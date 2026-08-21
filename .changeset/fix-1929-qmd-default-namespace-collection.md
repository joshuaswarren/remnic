---
"@remnic/core": patch
---

Fix QMD recall returning 0 results for a configured default namespace whose data lives at the flat memory root (#1929). The default-namespace record derived the base QMD collection on both the index and search sides but skipped auto-creating it, so a fresh namespace-enabled install with any flat-root default (custom like `geek` or the unset default) left maintenance running with no collection and empty recall. The base ("broad root") collection is now auto-created for the legacy-default-root case; `filterNamespaceSubtreeResults` still strips the nested `namespaces/` subtree from default-namespace results, so index and search stay symmetric and nested data does not leak into default recall. Legacy installs that already have the base collection are unaffected (auto-create is a no-op when present).
