# PR30: Utility Offline Learner

## Goal

Turn PR29's typed utility telemetry into a bounded offline learning artifact that
later slices can consume without reinterpreting raw events on the hot path.

This slice stays offline and operator-facing. It should read persisted utility
events, learn bounded promotion/ranking weights, persist a typed learner
snapshot, and expose status/learn commands. It must not change live recall or
promotion behavior yet.

## Scope

- add a deterministic offline learner over utility telemetry events
- persist a typed learner snapshot under the utility-telemetry state root
- expose operator-facing `utility-learning-status` and `utility-learn` commands
- keep all behavior behind the existing `memoryUtilityLearningEnabled` flag
- keep learned weights bounded so PR31 can apply them safely later

## Acceptance

- the learner reads only utility telemetry events within a bounded time window
- weights are grouped by `target + decision`
- low-sample groups are excluded from learned output
- learned weights are bounded and confidence-scored
- the learner persists a stable typed snapshot for later runtime consumption
- `openclaw engram utility-learn` writes a snapshot only when utility learning is enabled
- `openclaw engram utility-learning-status` reports snapshot metadata and weight counts

## Non-Goals

- runtime promotion/ranking changes
- automatic background learning cycles
- new feature flags beyond the existing utility-learning gates
- any heuristic that bypasses the persisted telemetry contract
