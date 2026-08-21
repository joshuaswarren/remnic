# Engram PR5: Objective-State Store Foundation

**Status:** planned for implementation in this slice  
**Roadmap track:** Objective-state memory as a first-class store  
**Primary source:** AMA-Bench / AMA-Agent — https://arxiv.org/abs/2602.22769

## Goal

Ship the first objective-state memory slice as a storage contract, not as retrieval behavior. This PR creates a typed snapshot schema and an on-disk store for normalized world/tool state changes so later PRs can add writers and retrieval hooks without inventing the storage format midstream.

## Why This Slice Exists

The roadmap’s second priority is objective-state plus causal trajectory memory. The main problem called out by AMA-Bench / AMA-Agent is that agent-memory systems miss objective state: what command ran, what file changed, what record exists now, and what the resulting world state became. Engram already stores facts and artifacts, but it needs a separate store for normalized state snapshots before it can rank or retrieve them.

## Scope

This slice includes:

- config flags for enabling objective-state memory and snapshot writes
- a typed objective-state snapshot schema
- a dedicated store rooted at `{memoryDir}/state/objective-state`
- validation and status inspection helpers
- a CLI status command for operators and tests/docs for the new contract

This slice does **not** include:

- automatic runtime snapshot writers
- recall injection or ranking changes
- causal trajectory linking
- trust-zone or poisoning defenses

## Flags

- `objectiveStateMemoryEnabled`
- `objectiveStateSnapshotWritesEnabled`
- `objectiveStateStoreDir`

All are defaults-off to preserve current Engram behavior.

## Storage Contract

- store root: `{memoryDir}/state/objective-state`
- dated snapshot path: `snapshots/YYYY-MM-DD/<snapshotId>.json`
- schema is append-only and fail-open for later writers

## Verification

- config parsing tests confirm defaults and overrides
- snapshot validation tests confirm the schema contract
- store/status tests confirm valid + invalid artifact reporting
- CLI status tests confirm operator visibility into the new store

## Follow-on PRs

- PR6: normalized file/tool/process snapshot writers
- PR7: objective-state retrieval formatter and ranking hooks
