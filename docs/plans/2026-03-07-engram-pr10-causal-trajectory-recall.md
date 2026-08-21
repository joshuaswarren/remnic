# Engram PR10: Trajectory-Aware Recall And Explainability

## Goal

Ship the first retrieval layer for causal trajectories so Engram can inject prompt-relevant `goal -> action -> observation -> outcome -> follow-up` chains into recall context.

## Why This Slice Exists

PR8 created the causal-trajectory store. PR9 bridged those records into deterministic graph edges. The next gap is retrieval: stored trajectories and graph edges are only infrastructure until recall can surface the most relevant chain back to the agent.

This slice keeps the first version deliberately bounded:

- defaults off
- no graph traversal weighting yet
- no objective-state linking beyond stored refs
- lightweight explainability instead of heavy reasoning

## Scope

- Add `causalTrajectoryRecallEnabled` as a defaults-off config flag.
- Add a `causal-trajectories` recall-pipeline section with bounded defaults.
- Add store-side lexical search over:
  - `goal`
  - `actionSummary`
  - `observationSummary`
  - `outcomeSummary`
  - `followUpSummary`
  - tags / entity refs / objective-state refs
- Add `## Causal Trajectories` recall formatting with lightweight `matched:` explainability.
- Add focused tests for:
  - direct search relevance
  - recall injection
  - flag gating
  - config defaults/overrides

## Out Of Scope

- graph traversal/ranking
- retrieval blending with objective-state recall
- trust-zone or poisoning enforcement
- benchmark scoring for trajectory recall quality

## Verification

1. `npx tsx --test tests/causal-trajectory-recall.test.ts tests/config-eval-harness.test.ts`
2. `npm run check-types`
3. `npm test`
4. `npm run build`
