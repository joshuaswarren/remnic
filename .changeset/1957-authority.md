---
"@remnic/core": minor
---

Add shared-context actor authority check (issue #1957). `checkAuthority` rejects a missing actor, allows an empty required role, and forbids a mismatch. Part of #1957.
