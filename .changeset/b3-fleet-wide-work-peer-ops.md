---
"@remnic/core": patch
---

The work_task, work_project, work_board operations and the six peer operations (peer_list, peer_get, peer_set, peer_delete, peer_profile_get, peer_forget) now require an unrestricted namespace axis, because they all write to global stores that a namespace argument cannot isolate. A token whose capabilities carry a namespaces allow-list, including an empty one, is rejected before any read or mutation. Tokens restricted only on the operations axis and legacy unrestricted tokens keep working. The HTTP peer routes now dispatch through the same registered operations as MCP, so REST enforces the identical operation policy instead of checking only the operations axis.

Stability: stable
