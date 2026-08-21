# Published Benchmark Readiness

This page summarizes the #841-#850 benchmark-readiness work. It is an
audit checklist for running Remnic against published memory benchmarks
without relying on hidden answer metadata.

## Core Rule

Remnic may retrieve exact evidence from explicit cues when the cues are
visible in the user question or stored memory. The harness must not route
answering recall through hidden fields such as gold answers, target ids,
final state, evidence labels, or source ids unless those values are also
present in the user-visible prompt or ingested memory.

## Implemented Coverage

| Issue | Benchmark / surface | Implemented behavior | Verification signal |
| --- | --- | --- | --- |
| #841 | Core recall | Explicit cue recall stage for stored cue anchors, session/turn/date/speaker/plan/field style evidence, and recall x-ray attribution | `packages/remnic-core/src/explicit-cue-recall.test.ts`, `tests/config-memory-os-preset.test.ts` |
| #842 | AMA-Bench | Trajectory action/observation/step evidence flows through stored trajectory cues and recommended judge hooks | `tests/bench-ama-bench-runner.test.ts` |
| #843 | LoCoMo | Dialogue id, speaker, session, and temporal cue recall without using hidden `qa.evidence` for answering | `tests/bench-locomo-runner.test.ts` |
| #844 | LongMemEval | Temporal and session cue formatting, while answer session ids remain reporting metadata | `packages/bench/src/benchmarks/published/longmemeval/runner.test.ts` |
| #845 | AMemGym | Latest-state and supersession-safe question handling without final-state injection | `tests/bench-amemgym-runner.test.ts` |
| #846 | MemoryArena | Structured plan field, traveler/day, and dependency anchors for stored planning state | `tests/bench-memory-arena-runner.test.ts` |
| #847 | BEAM | Query-visible plan/chat/source anchors, with hidden source metadata kept reporting-only | `tests/bench-beam-runner.test.ts` |
| #848 | MemBench | Step/time cues from stored transcript position, with target step ids reserved for recall@10 scoring | `tests/bench-membench-runner.test.ts` |
| #849 | MemoryAgentBench | Content-derived event, date, keypoint, chunk, and latest-fact cues | `tests/bench-memoryagentbench-runner.test.ts` |
| #850 | PersonaMem-v2 | Preference/persona anchors, latest preference updates, hidden metadata non-leakage, and anchor stripping before scoring | `tests/bench-personamem-runner.test.ts` |

## Full Run Requirements

Use full mode for any public or leaderboard-style result:

- Run against full published datasets, not quick smoke fixtures.
- Use an isolated benchmark Remnic memory directory.
- Enable the full benchmark runtime profile, including QMD and explicit
  cue recall.
- Lock dataset versions, model ids, judge model ids, seeds, Remnic commit
  SHA, run config, and artifact manifest.
- Preserve raw result artifacts and verification output.
- Redact provider secrets before publishing artifacts or run manifests.

## Non-Goals

The benchmark harness may improve recall by making stored, visible
structure explicit, but it must not encode the answer. For example:

- Allowed: adding a stored line such as `MemoryArena structured plan
  field anchors: day=2; field=dinner` when those values are derived from
  the stored plan.
- Not allowed: adding the expected dinner value from a gold answer field
  if that value was not stored in the memory state.
- Allowed: using `targetStepIds` for MemBench recall@10 scoring.
- Not allowed: using `targetStepIds` to construct the text passed to
  answering recall.

## Publication Checklist

Before publishing a result to Remnic.ai:

- `remnic bench list` includes the benchmark id.
- Full-mode dataset status is present for that benchmark.
- Run metadata records model, judge, seed, runtime profile, commit SHA,
  and dataset/version manifest.
- Artifacts pass schema validation.
- Harness leakage tests for that benchmark pass.
- The result is labeled as quick/smoke if any bundled fixture was used.
