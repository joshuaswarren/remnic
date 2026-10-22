---
"@remnic/core": patch
---

Enforce namespace read policies for entity list/get operations. HTTP, MCP, and chat pass the authenticated principal to the shared service check. Namespace-enabled callers must supply an authorized principal. Namespace-disabled callers can still read the default store without a principal.

Stability: stable
