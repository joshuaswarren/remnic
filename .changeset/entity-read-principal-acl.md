---
"@remnic/core": patch
---

Enforce namespace read policies for entity list/get operations. HTTP, MCP, and chat pass the authenticated principal to the shared service check.

Behaviour change to know about: with namespaces turned on, an entity read that arrives with no principal (a client that sent no identity and a server with no configured principal) now fails with "authentication required", the same answer memory reads already give. A caller whose principal is not allowed to read the namespace gets "namespace is not readable". With namespaces turned off nothing changes: the default store can still be read without a principal.

Stability: stable
