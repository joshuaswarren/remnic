# PR19: Harmonic Retrieval Blender And Diagnostics

## Goal

Ship the first actual harmonic retrieval behavior:

- blend abstraction-node relevance with cue-anchor relevance
- inject the blend through a bounded recall section
- expose query diagnostics through a CLI surface

## Why This Slice Exists

PR17 added abstraction-node storage.
PR18 added cue-anchor indexing.
PR19 is the first slice that actually uses both together.

This follows the roadmap in
`docs/plans/2026-03-06-engram-agentic-memory-roadmap.md`:

1. PR17: abstraction-node schema
2. PR18: cue-anchor index
3. PR19: harmonic retrieval blender and diagnostics

## Scope

### Included

- `searchHarmonicRetrieval(...)`
- blending over:
  - node title / summary / tags / entity refs
  - cue-anchor values / normalized cues / types / tags
- same-session tie-break support
- matched-field diagnostics
- matched-anchor diagnostics
- `## Harmonic Retrieval` recall section
- `openclaw engram harmonic-search <query>`
- recall-pipeline default entry for `harmonic-retrieval`
- focused tests and docs updates

### Excluded

- no learned weights
- no writer automation for abstraction nodes or anchors
- no hidden blending into generic `memories` ranking
- no verified episodic recall logic yet

## Behavioral Contract

When `harmonicRetrievalEnabled` is on and the pipeline section is enabled:

- Engram searches abstraction nodes first-class
- cue-anchor hits contribute extra score and explainability
- harmonic results render as their own recall section

When `abstractionAnchorsEnabled` is off:

- harmonic retrieval still works over abstraction nodes
- cue anchors simply do not contribute additional score

The section must stay bounded and fail-open:

- empty or stopword-only queries return no harmonic matches
- malformed node/anchor files are ignored by recall and remain visible via the
  existing status tooling

## Diagnostics

Each result exposes:

- `nodeScore`
- `anchorScore`
- `matchedFields`
- `matchedAnchors`

The recall formatter surfaces those diagnostics in compact human-readable form.
The CLI command returns the structured result payload directly.

## Test Plan

Focused red-green tests:

- harmonic search blends node and anchor evidence
- stopword-only query returns no matches
- CLI search returns blended results
- recall injects `## Harmonic Retrieval`
- recall omits the section when the feature flag is off
- recall omits the section when the pipeline entry is disabled

Verification before PR:

- `npx tsx --test tests/harmonic-retrieval.test.ts tests/cue-anchors.test.ts tests/abstraction-nodes.test.ts tests/config-eval-harness.test.ts`
- `npm run check-types`
- `npm run check-config-contract`
- `npm test`
- `npm run build`

## Review Focus

- keep harmonic retrieval inspectable; do not hide it inside generic memories
- maintain a clear score breakdown between abstraction and anchor evidence
- keep malformed storage artifacts fail-open for recall
- avoid accidental coupling to later PR20 verified-recall work
