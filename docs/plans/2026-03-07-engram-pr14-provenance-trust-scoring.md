# Engram PR14: Provenance Trust Scoring

## Goal

Ship the first bounded poisoning-defense slice from the roadmap by adding
deterministic provenance trust scoring for trust-zone records behind a dedicated
config flag.

This slice implements PR14 from the benchmark-first roadmap in
[2026-03-06-engram-agentic-memory-roadmap.md](./2026-03-06-engram-agentic-memory-roadmap.md)
and supports the larger memory-defense track motivated by:

- AMA-Bench / AMA-Agent: https://arxiv.org/abs/2602.22769
- AgentSys: https://arxiv.org/abs/2602.07398
- AgentLAB: https://arxiv.org/abs/2602.16901

## Why This Slice Exists

PR11 through PR13 created the trust-zone store, promotion path, and retrieval
surface. The next missing piece is a measurable trust signal. Without that,
later corroboration rules and attack benchmarks would have to reason about
trust implicitly.

PR14 therefore adds a deterministic score that can be inspected by operators
and asserted in tests before any automatic decision logic lands.

## Scope

In scope:

- Add `memoryPoisoningDefenseEnabled` to the config/types/plugin schema.
- Add a pure provenance scoring helper for trust-zone records.
- Score records from provenance structure only:
  - source class
  - `sourceId`
  - `evidenceHash`
  - `sessionKey`
- Surface aggregate score information in `trust-zone-status`.
- Add regression tests for deterministic scoring and status summaries.
- Update README, config reference, theory, and changelog.

Out of scope:

- Corroboration requirements across multiple records.
- Automatic promotion changes.
- Attack benchmark packs or adversarial replay.
- Retrieval ranking changes based on the score.

## Contract

The score must be:

- deterministic for a given stored record
- bounded to `0..1`
- explainable through a simple breakdown
- defaults-off behind `memoryPoisoningDefenseEnabled`

The first scoring model is intentionally simple:

- base weight by provenance source class
- additive bonuses for `sourceId`, `evidenceHash`, and `sessionKey`
- derived trust band (`low`, `medium`, `high`)

## Verification

- `npx tsx --test tests/config-eval-harness.test.ts`
- `npx tsx --test tests/trust-zones.test.ts`
- `npm run check-types`
- `npm run check-config-contract`
- `npm test`
- `npm run build`

## Follow-on Slice

PR15 should consume this explicit score surface to add corroboration rules for
risky promotions rather than re-deriving provenance quality ad hoc.
