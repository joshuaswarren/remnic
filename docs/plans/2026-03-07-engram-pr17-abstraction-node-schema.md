# PR17: Abstraction-Node Schema

## Goal

Ship the first harmonic-retrieval foundation slice without blending anything
 into live recall yet.

This PR introduces a typed abstraction-node store so later slices can attach
 cue anchors and retrieval blending to a stable persistence contract instead of
 inventing schema and heuristics at the same time.

## Scope

- add `harmonicRetrievalEnabled`
- add `abstractionAnchorsEnabled`
- add `abstractionNodeStoreDir`
- add a typed abstraction-node contract and dated store layout
- add `openclaw engram abstraction-node-status`
- document the new foundation surface

## Non-Goals

- no cue-anchor index yet
- no harmonic retrieval ranking/blending yet
- no new recall-pipeline injection yet
- no model-generated abstraction writer yet

## Contract

Abstraction nodes are typed summaries that compress durable memory structure
 without trying to store every retrieval cue in this slice.

Schema:

- `nodeId`
- `recordedAt`
- `sessionKey`
- `kind`: `episode | topic | project | workflow | constraint`
- `abstractionLevel`: `micro | meso | macro`
- `title`
- `summary`
- optional `sourceMemoryIds`
- optional `entityRefs`
- optional `tags`
- optional `metadata`

Storage layout:

- `{memoryDir}/state/abstraction-nodes/nodes/YYYY-MM-DD/<nodeId>.json`

## Why This Slice First

The harmonic retrieval roadmap depends on an explicit abstraction layer:

1. PR17 defines abstraction-node storage.
2. PR18 adds cue-anchor indexing for entities/files/tools/outcomes/constraints/dates.
3. PR19 blends abstractions and anchors into retrieval diagnostics.

Keeping PR17 storage-only preserves small-slice discipline and makes later
 review easier because any retrieval regression will happen after the data
 contract is already stable.

## Verification

- config parsing defaults/custom overrides
- abstraction-node validation and persistence
- abstraction-node store status with invalid artifact reporting
- CLI status wrapper for operator inspection
