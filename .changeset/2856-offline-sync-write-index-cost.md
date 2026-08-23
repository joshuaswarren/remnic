---
"@remnic/core": patch
---

An offline-sync (converge) file write where neither the existing file nor the incoming memory is tombstone-blocked no longer rebuilds the tombstone-blocked capture index. The index only holds blocked explicit-capture keys, so those writes cannot change it, but the unconditional rebuild re-read the whole corpus per replicated file — measured 15-31s per write against a ~190k-file corpus, turning a boot-scale `converge apply` into a multi-week projection. Blocked, unblocked, and blocked-to-active transitions still rebuild as before.
