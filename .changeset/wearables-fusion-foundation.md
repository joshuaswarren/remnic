---
"@remnic/core": minor
---

Add deterministic, config-gated cross-source wearable transcript fusion
(issue #1810). Introduces a `wearables/fusion/` module that clusters
same-day conversations from multiple enabled sources by time
overlap/proximity, reconciles text (preferring higher source trust and
more-complete transcripts) and speakers deterministically, surfaces
unresolved conflicts as `disagreements[]`, and writes a derived
`FusedWearableConversation` artifact alongside raw transcripts with a
stable content-hash id (idempotent re-runs). Gated behind
`wearables.fusion.enabled` (default false) — no behavior change when
disabled. LLM-assisted reconciliation, memory extraction over fused
artifacts, full segment-level alignment, and search-index integration
are deferred follow-ups.
