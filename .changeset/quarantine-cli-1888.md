---
"@remnic/core": patch
"@remnic/cli": patch
---

Operator visibility for quarantined writes (issue #1888, part 2). Adds `remnic quarantine list [--json]` to show the writes the namespace ACL rejected and dead-lettered (operation, principal, attempted namespace, timestamp) instead of leaving them invisible, and a `remnic doctor` "Quarantined writes" warning (count + remediation, and an "unable to inspect" warning if the store can't be read). `WriteQuarantineStore` is exposed via a new `@remnic/core/write-quarantine` subpath export. The recovery command (`remnic quarantine replay`) is a deliberate follow-up: a correct replay must re-submit without the write surface re-quarantining the replay attempt, which needs a quarantine-suppression flag threaded through the access layer.
