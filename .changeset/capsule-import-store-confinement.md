---
"@remnic/core": patch
Stability: stable
---

Capsule import over HTTP and MCP now accepts `archivePath` only from inside the destination namespace's capsule store, the same directory `capsules/export` writes and `capsule_list` lists. Remote clients that passed any other server path must copy the archive into that store first or use the CLI, which keeps unrestricted local-path import for operators.
