---
"@remnic/core": patch
---

Scope the entity migration's search-maintenance request to the namespace it rewrote. A request for one namespace is now served as soon as a QMD pass ran that namespace, and only a pass after the request can serve it, so it no longer inherits coverage from earlier passes and is no longer held up when the cycle budget skips other namespaces. A request without a namespace behaves as before. Refs #3289; fixes #3290.
