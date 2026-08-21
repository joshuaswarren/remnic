# PR29: Utility-Telemetry Schema

## Goal

Add the first typed utility-learning contract so later slices can learn from
real downstream outcomes instead of inference or anecdotes.

This slice is intentionally narrow: it creates durable telemetry storage,
operator-facing status/write commands, and the feature flags that gate future
promotion-by-outcome work.

## Scope

- add `memoryUtilityLearningEnabled` and `promotionByOutcomeEnabled`
- persist typed utility telemetry events in a date-partitioned store
- expose operator-facing `utility-status` and `utility-record` CLI commands
- report valid/invalid event counts plus target/decision/outcome breakdowns
- keep runtime behavior bounded and deterministic

## Acceptance

- utility telemetry events validate against a stable typed schema
- events persist under `{memoryDir}/state/utility-telemetry/events/YYYY-MM-DD`
- disabled mode short-circuits cleanly without scanning the store
- `openclaw engram utility-status` reports counts and latest-event metadata
- `openclaw engram utility-record` writes an event only when utility learning is enabled
- config parsing and plugin schema both expose the two new roadmap flags

## Non-Goals

- offline utility-weight learning
- runtime promotion/ranking weight application
- automatic telemetry capture from every recall path
- promotion-policy changes beyond config/schema surfacing
