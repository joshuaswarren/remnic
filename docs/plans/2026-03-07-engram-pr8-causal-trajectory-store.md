# Engram PR8: Causal Trajectory Store

## Goal

Ship the first causal-trajectory memory slice as a storage contract, not as
retrieval or graph behavior. This PR creates a typed store for
`goal -> action -> observation -> outcome -> follow-up` records so later slices
can build action-conditioned graphs and trajectory-aware retrieval without
inventing the schema midstream.

## Why This Slice Exists

PR7 made objective-state snapshots recallable, but AMA-Bench / AMA-Agent argues
that agent systems still fail when they cannot reconstruct causality from real
trajectories. PR8 is the smallest next step: preserve typed causal chains on
disk behind a default-off flag.

Source:
- AMA-Bench / AMA-Agent: https://arxiv.org/abs/2602.22769

## In Scope

- `causalTrajectoryMemoryEnabled` config flag
- `causalTrajectoryStoreDir` config override
- typed causal trajectory record schema
- dated on-disk storage rooted at `{memoryDir}/state/causal-trajectories`
- status helper and CLI command for operator visibility
- tests for validation, persistence, and status reporting
- README/config/plugin/docs updates for the shipped surface

## Out Of Scope

- trajectory writers from live agent/tool activity
- action-conditioned graph edges
- trajectory-aware recall injection
- trust-zone/provenance enforcement

## Verification

1. `npx tsx --test tests/causal-trajectory.test.ts`
2. `npm run check-types`
3. `npm test`
4. `npm run build`

## Follow-On Slices

- PR9: action-conditioned graph construction
- PR10: trajectory-aware retrieval and explainability
