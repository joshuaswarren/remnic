# Engram PR7: Objective-State Recall

**Status:** planned for implementation in this slice  
**Roadmap track:** Objective-state memory as a first-class store  
**Primary source:** AMA-Bench / AMA-Agent — https://arxiv.org/abs/2602.22769

## Goal

Ship the first retrieval layer for objective-state memory. This slice makes
Engram able to inject prompt-relevant objective-state snapshots into recall
context without changing the existing memory search pipeline.

## Why This Slice Exists

PR5 created the objective-state store. PR6 started writing normalized file,
process, and tool outcomes into it. The next gap is retrieval: if the system
cannot surface that state at recall time, objective-state memory still exists
only as an operator-facing ledger instead of agent-usable memory.

AMA-Bench / AMA-Agent argues that agent systems fail when they cannot recover
what actually happened in the world. PR7 is the smallest slice that starts
closing that loop without yet introducing full causal trajectories or heavy
ranking changes.

## Scope

This slice includes:

- a new `objectiveStateRecallEnabled` flag, defaults off
- a default recall-pipeline section for `objective-state`, disabled unless the
  new flag is enabled
- bounded store-side search/ranking over objective-state snapshots
- formatted objective-state recall injection in `recallInternal()`
- tests covering store ranking, recall injection, flag gating, and config
  defaults

This slice does **not** include:

- causal trajectory linking across snapshots
- trust-zone filtering or provenance promotion
- benchmark tasks that score objective-state recall quality directly
- any change to the existing `memories` QMD retrieval section

## Flags

- `objectiveStateMemoryEnabled`
- `objectiveStateSnapshotWritesEnabled`
- `objectiveStateRecallEnabled`

Objective-state recall is only active when the storage foundation is enabled and
the dedicated recall flag is also enabled.

## Retrieval Contract

- source: validated objective-state snapshots already stored on disk
- query signal: prompt-token overlap across `scope`, `summary`, `command`,
  `toolName`, tags, and entity refs
- ranking: bounded lexical relevance plus light recency/session bias
- output section: `## Objective State`

## Verification

1. `npx tsx --test tests/objective-state.test.ts tests/objective-state-recall.test.ts tests/config-eval-harness.test.ts`
2. `npm run check-types`
3. `npm test`
4. `npm run build`

## Follow-on PRs

- PR8: causal trajectory schema and storage
- PR9: action-conditioned graph construction
