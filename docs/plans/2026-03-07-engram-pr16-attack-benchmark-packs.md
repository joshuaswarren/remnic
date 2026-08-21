# Engram PR16: Attack Benchmark Packs and Regression Suite Foundation

## Goal

Ship the third bounded poisoning-defense slice from the roadmap by teaching the
evaluation harness to recognize memory red-team benchmark packs as first-class
operator assets.

This slice implements PR16 from
[2026-03-06-engram-agentic-memory-roadmap.md](./2026-03-06-engram-agentic-memory-roadmap.md)
and builds directly on PR14's provenance scoring plus PR15's corroboration
rules.

Relevant sources:

- AMA-Bench / AMA-Agent: https://arxiv.org/abs/2602.22769
- AgentLAB: https://arxiv.org/abs/2602.16901
- AgentSys: https://arxiv.org/abs/2602.07398

## Why This Slice Exists

PR14 and PR15 made poisoning defense measurable and enforceable inside the
trust-zone promotion path. What Engram still lacked was a typed way to track
the attack suites that should keep those defenses honest over time.

The eval harness already supports benchmark manifests, imports, and status
reporting. PR16 extends that existing substrate so poisoning-defense benchmark
packs can be validated, imported, and counted explicitly instead of hiding
inside generic benchmark metadata.

## Scope

In scope:

- Add a defaults-off `memoryRedTeamBenchEnabled` config/schema flag.
- Extend eval benchmark manifests with a bounded benchmark type contract:
  - `standard`
  - `memory-red-team`
- Require `attackClass` and `targetSurface` on `memory-red-team` manifests.
- Surface red-team benchmark counts and unique attack metadata in
  `openclaw engram benchmark-status`.
- Add regression tests for:
  - valid memory red-team pack validation
  - rejected red-team packs missing attack metadata
  - red-team benchmark status accounting
- Update roadmap-facing docs, config docs, README, theory, and changelog.

Out of scope:

- automated attack replay execution
- benchmark-runner orchestration
- retrieval/ranking changes driven by red-team outcomes
- additional poisoning policy beyond PR15's corroboration rule

## Contract

The PR16 contract must be:

- defaults-off behind `memoryRedTeamBenchEnabled`
- backward-compatible for existing benchmark packs
- explicit about poisoning-defense intent through typed metadata, not tag
  conventions alone
- bounded to manifest/import/status surfaces only

The first red-team benchmark contract is intentionally minimal:

- `benchmarkType: "memory-red-team"`
- `attackClass: <non-empty string>`
- `targetSurface: <non-empty string>`

## Verification

- `npx tsx --test tests/config-eval-harness.test.ts tests/evals-benchmark-tools.test.ts tests/cli-benchmark-status.test.ts`
- `npm run check-types`
- `npm run check-config-contract`
- `npm test`
- `npm run build`

## Follow-on Slice

PR17 should return to the roadmap's harmonic-retrieval track. The actual
red-team runner/execution layer can come back later once the attack-pack
contract is stable and benchmark assets exist to run.
