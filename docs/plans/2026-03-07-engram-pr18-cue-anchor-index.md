# PR18: Cue-Anchor Index Foundation

## Goal

Add the second harmonic-retrieval substrate slice:

- typed cue-anchor storage for abstraction nodes
- operator-facing anchor status inspection
- no retrieval blending yet

## Why This Slice Exists

PR17 made abstraction nodes explicit and inspectable. PR18 makes those nodes
addressable through concrete cues before any ranking logic tries to blend
abstractions with semantic recall.

This follows the roadmap sequence in
`docs/plans/2026-03-06-engram-agentic-memory-roadmap.md`:

1. PR17: abstraction-node schema
2. PR18: cue-anchor index
3. PR19: harmonic retrieval blender and diagnostics

## Scope

### Included

- new typed cue-anchor contract
- cue-anchor storage rooted under `{abstractionNodeStoreDir}/anchors`
- cue types for:
  - `entity`
  - `file`
  - `tool`
  - `outcome`
  - `constraint`
  - `date`
- per-anchor linkage to one or more abstraction-node IDs
- `openclaw engram cue-anchor-status`
- tests for validation, persistence, status reporting, and CLI wrapper
- README/config/changelog/theory updates

### Excluded

- no abstraction writer automation yet
- no retrieval blending yet
- no scoring/weighting heuristics
- no new top-level config flags beyond the existing harmonic-retrieval flags

## Contract

Each cue anchor stores:

- `schemaVersion`
- `anchorId`
- `anchorType`
- `anchorValue`
- `normalizedCue`
- `recordedAt`
- `sessionKey`
- `nodeRefs`
- optional `tags`
- optional `metadata`

Persistence layout:

```text
{memoryDir}/state/abstraction-nodes/anchors/{anchorType}/{anchorId}.json
```

Status surface reports:

- total / valid / invalid anchors
- counts by cue type
- total linked node references
- latest anchor metadata
- invalid anchor file list

## Flags

- `harmonicRetrievalEnabled`
- `abstractionAnchorsEnabled`

Behavior stays fail-open and inert unless operators enable those harmonic
retrieval flags.

## Test Plan

Focused red-green tests:

- path resolution
- schema validation
- typed persistence path
- unsafe id / empty node-ref rejection
- valid + invalid status accounting
- CLI wrapper status output

Verification before PR:

- `npx tsx --test tests/cue-anchors.test.ts tests/abstraction-nodes.test.ts tests/config-eval-harness.test.ts`
- `npm run check-types`
- `npm run check-config-contract`
- `npm test`
- `npm run build`

## Review Focus

- cue typing and validation should stay deterministic
- anchor storage should remain separate from retrieval logic
- CLI/status output should make malformed anchor files obvious
- no accidental retrieval blending or new ranking behavior should appear in this slice
