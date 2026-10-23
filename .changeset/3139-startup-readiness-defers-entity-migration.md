---
"@remnic/core": patch
---

Let startup read readiness proceed without running the entity canonical-id migration (partial #3139). Startup records the migration as deferred instead of running it, so read-only startup is never held behind the migration lock; the migration still runs on the next default directory setup and on secure-store unlock. Startup retains safe-root and entity-entry validation, and default directory setup still awaits the migration.

Stability: stable
