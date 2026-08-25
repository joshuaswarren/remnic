---
"@remnic/core": patch
"@remnic/cli": patch
---

Converge identity-cache follow-ups (performance only): the support-passport exclusion classification now persists for files the snapshot iterator excludes, so later cycles skip the repeated stat/read/classify work instead of recomputing it every plan; and concurrent cache merges keep the `statIdentity`/`excluded` fields from either writer rather than dropping them. Identity and reconcile decisions, and deleted-path non-resurrection, are unchanged — an excluded file's cache entry carries no reusable identity, and paths the walk never saw are still pruned.
