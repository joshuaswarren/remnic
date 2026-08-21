# PR31: Utility Runtime Weights

## Goal

Consume PR30's persisted utility-learning snapshot at runtime in a bounded,
fail-open way so Engram can start learning from downstream outcomes without
letting the hot path reinterpret raw utility telemetry.

## Scope

- load the latest utility-learning snapshot only when both
  `memoryUtilityLearningEnabled` and `promotionByOutcomeEnabled` are enabled
- clamp learned snapshot values into bounded runtime multipliers and threshold
  deltas
- apply those bounded values to ranking heuristic deltas in `boostSearchResults`
- apply bounded promotion/demotion threshold nudges to tier-migration policy
- keep missing/invalid snapshots a true no-op

## Acceptance

- runtime weighting is disabled unless both existing utility-learning gates are enabled
- runtime loading reads only the persisted learner snapshot, not the raw telemetry ledger
- positive ranking deltas are multiplied by a bounded `boost` multiplier
- negative ranking deltas and suppressive penalties are multiplied by a bounded `suppress` multiplier
- promotion and demotion thresholds are nudged by bounded deltas derived from learned promotion weights
- all runtime changes fail open to baseline behavior when no snapshot exists
- targeted tests cover disabled mode, clamping, ranking application, and existing adjacent utility/tier suites

## Non-Goals

- automatic background reloading of the learner snapshot
- new feature flags beyond `memoryUtilityLearningEnabled` and `promotionByOutcomeEnabled`
- runtime interpretation of raw utility telemetry events
- benchmark-driven auto-tuning beyond the persisted learner snapshot contract
