---
"@remnic/core": patch
---

Let startup read readiness proceed without running the entity canonical-id migration (partial #3139). Startup records the migration as deferred instead of running it, so read-only startup is never held behind the migration lock; the migration still runs on the next default directory setup and on secure-store unlock. Startup retains safe-root and entity-entry validation, and default directory setup still awaits the migration.

Preserve canonical-ID reads of legacy filenames before a journal exists, reject ambiguous fallback matches, and wait for migration at every entity mutation boundary (including legacy-ID synthesis calls). Completed deferred migrations request the existing debounced search-maintenance scheduler for primary and namespace stores, without depending on automatic embedding.

Completed journals now attest to the migration input fingerprint. Read misses skip legacy scans only while that attestation matches live entity entries, aliases, mutation versions and reconcile markers; stale or older journals retain compatibility reads without replaying migration.

Stability: stable
