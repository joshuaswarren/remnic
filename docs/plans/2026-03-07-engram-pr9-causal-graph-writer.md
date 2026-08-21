# Engram PR9: Action-Conditioned Causal Graph Construction

## Goal

Turn typed causal-trajectory records into deterministic causal-graph edges without changing recall behavior yet.

## Why This Slice

PR8 created the causal-trajectory store, but those records were still isolated JSON artifacts. PR9 bridges that store into the existing graph substrate so PR10 can build trajectory-aware retrieval and explainability on top of a durable graph contract instead of inferring chains from transcripts later.

## Scope

- Add `actionGraphRecallEnabled` as an explicit defaults-off config flag.
- Add a causal-trajectory graph helper module that derives deterministic synthetic node IDs for:
  - `goal`
  - `action`
  - `observation`
  - `outcome`
  - optional `follow_up`
- Write those edges into the existing causal graph JSONL store.
- Optionally wire graph construction into `recordCausalTrajectory(...)` when the new flag is enabled.
- Add focused tests for edge derivation, graph writes, and config parsing.

## Out Of Scope

- Retrieval/ranking changes
- Graph traversal weighting changes
- Objective-state snapshot node linking
- Explanations or prompt formatting

## Expected Result

After PR9, Engram still behaves the same at recall time, but it now accumulates action-conditioned causal-stage edges in the graph whenever typed trajectory recording and action-graph wiring are both enabled.
