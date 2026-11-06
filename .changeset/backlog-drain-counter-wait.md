---
"@remnic/server": patch
Stability: stable
---

Wait for the backlog scheduler's processed counter in the drain server test instead of sampling it after a mid-drain side effect. This removes a load-sensitive test race.
