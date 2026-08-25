---
"@remnic/core": minor
---

Corroboration-graduated seed memories, foundation layer (issue #2974): a
`pending_review` memory must not promote on its own echo. Until now every
promotion path required a review step, so in unattended deployments the review
queue only grows; the only automatic promotion (wearable cross-device
corroboration) is scoped to wearable rows.

- New `lifecycle/seed-graduation.ts` in `@remnic/core`. The gate counts
  corroborating evidence for a seed deterministically — token-coverage
  similarity via the shared recall tokenizer, no LLM on this path — and
  graduates only when evidence from an INDEPENDENT provenance arrives:
  a different session than the seed's (when both carry session anchors), a
  different source otherwise, never a lineage descendant, and never a session
  whose recall history shows the seed was injected there. Echo fails closed:
  provenance that cannot be shown independent never corroborates.
- `runSeedGraduationPass` sweeps a namespace's `pending_review` seeds and
  promotes the corroborated ones in place through the existing
  `StorageManager.promoteWearableMemory` status flip — the same lifecycle
  machinery the wearable path uses, not a parallel write path. Every
  graduation stamps `graduatedBy: independent-corroboration`,
  `corroborationCount`, and `corroboratingMemoryIds` (the audit surface
  naming the evidence); the memory lifecycle ledger already records the
  status transition itself.
- `parseSeedGraduationConfig` ships the strict `seedGraduation` block
  (`enabled`, default false; `minCorroborations`, default 2). Invalid values
  throw, never default. While disabled the pass is a zero-behavior no-op —
  review-mode promotion is untouched.

Not in this layer (follow-ups on #2974): wiring the key into `parseConfig`
(config.ts sits at its file-size ratchet), the conservative-preset pin,
scheduling the pass inside the lifecycle sweep via the recall handle history
as the echo lookup, contradiction holds/demotions, and the
docs/manifest surface.
