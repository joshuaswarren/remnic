---
"@remnic/core": patch
---

Stability: stable

Stop a coalesced keyed recall follower from inheriting its flight leader's caller-local failures: when the leader's own deadline or abort rejects its wait, the shared `persisted` gate now resolves so the follower proceeds on its own persistence outcome instead of failing with the leader's deadline while the shared work still completes. Also validate an expired client deadline before building the caller's abort race — the early return previously discarded an armed `raceAbort` promise that could reject unhandled — and keep the secure-store lock diagnostic visible under a tag filter, which now treats locked-store context as a non-memory diagnostic rather than unverified memory text.
