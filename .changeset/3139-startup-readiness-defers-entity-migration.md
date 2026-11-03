---
"@remnic/core": patch
---

Keep entity reads correct while the startup canonical-ID migration replays in the background (partial #3139). Canonical-ID reads find an unambiguous legacy filename before a journal exists and reject ambiguous fallback matches, and every entity mutation boundary (including legacy-ID synthesis calls) waits for the migration. Completed migrations request the existing debounced search-maintenance scheduler for primary and namespace stores, without depending on automatic embedding.

Completed journals now attest to the migration input fingerprint. Read misses skip legacy scans only while that attestation matches live entity entries, aliases, mutation versions and reconcile markers; stale or older journals retain compatibility reads without replaying migration. The completion check refuses a symlinked or out-of-base entities root before it fingerprints anything.

Stability: stable
