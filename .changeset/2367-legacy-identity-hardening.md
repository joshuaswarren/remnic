---
"@remnic/core": patch
"@remnic/cli": patch
---

Harden the legacy-identity migration path so a lossy legacy hash never selects or replaces an identity on its own (issue #2367). `buildTombstoneStore` now scopes its corpus path snapshot and source-content map to one tombstone ledger revision, so a legacy row appended by a peer process is verified on the next staleness reload instead of staying unverified until restart (unverified rows remain withheld from lookup tiers). `TombstoneStore.rebuild` requires an unambiguous legacy hash before replacing a persisted identity, keeping the explicit hash primary with the current body hash as an alias when the legacy normalizer is lossy (CJK-only bodies, accented skeletons). `parsedMemoryIdentity` in the reconcile manifest keeps an ambiguous persisted hash primary and exposes the recovered current identity as `contentHashAliases` (accepted by the peer manifest parser), so a replica carrying the same canonical source identity still collapses. Closes #2367.
