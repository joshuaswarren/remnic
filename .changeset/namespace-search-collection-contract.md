---
"@remnic/core": patch
---

Make MCP memory search collection handling namespace-aware. Namespace-enabled searches now scope omitted, base, and global collection requests to the caller's readable recall namespaces, accept namespace-derived collection names only for readable requested namespaces, and reject arbitrary custom collections instead of silently ignoring them.
