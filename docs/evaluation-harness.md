# Evaluation harness

Remnic is moving to a benchmark-first development model. This first slice adds the storage contract and status tooling for an AMA-Bench-style evaluation harness without changing live recall behavior.

For the memory-outcome dimensions and quick-benchmark coverage this harness measures, see [Memory evals](memory-evals.md).

## Why this exists

Recent agent-memory work is clear: memory should be evaluated on real agent trajectories, not chat QA. Remnic's evaluation harness is meant to answer one operational question for every memory PR:

`Did this make agent outcomes better, worse, or just different?`

Primary source:
- AMA-Bench / AMA-Agent: https://arxiv.org/abs/2602.22769

## Current scope

This slice ships:

- `evalHarnessEnabled`
- `evalShadowModeEnabled`
- `benchmarkBaselineSnapshotsEnabled`
- `benchmarkDeltaReporterEnabled`
- `evalStoreDir`
- `openclaw engram benchmark-status`
- `openclaw engram benchmark recall`
- `openclaw engram benchmark-validate <path>`
- `openclaw engram benchmark-import <path> [--force]`
- `openclaw engram benchmark-baseline-snapshot --snapshot-id <id>`
- `openclaw engram benchmark-baseline-report --snapshot-id <id>`
- `openclaw engram benchmark-ci-gate --base <dir> --candidate <dir>`
- typed benchmark manifest validation
- typed `memory-red-team` benchmark-pack validation for poisoning-defense suites
- typed run-summary validation
- typed shadow recall recording for live recall decisions
- typed base-vs-candidate eval-store comparison for CI gating

This slice does **not** yet ship:

- benchmark runners
- objective-state capture
- trust-zoned promotion logic

Those land in follow-on PR slices documented in the roadmap.

## Directory layout

By default, Remnic looks under:

```text
{memoryDir}/state/evals/
  benchmarks/
    <benchmark-id>/
      manifest.json
  runs/
    <run-id>.json
  shadow/
    YYYY-MM-DD/
      <trace-id>.json
  baselines/
    <snapshot-id>.json
```

You can override the root with `evalStoreDir`.

## Benchmark manifest format

```json
{
  "schemaVersion": 1,
  "benchmarkId": "ama-memory",
  "title": "AMA-style agent memory harness",
  "tags": ["trajectory", "objective-state"],
  "sourceLinks": ["https://arxiv.org/abs/2602.22769"],
  "cases": [
    {
      "id": "case-1",
      "prompt": "Resume the broken deployment and explain what changed.",
      "expectedSignals": ["objective-state", "causal-trajectory"]
    }
  ]
}
```

Required fields:

- `schemaVersion`
- `benchmarkId`
- `title`
- `cases[].id`
- `cases[].prompt`

Optional bounded benchmark-pack typing:

- `benchmarkType`: defaults to `standard`
- `memory-red-team` benchmark packs must also provide:
  - `attackClass`
  - `targetSurface`

Example red-team benchmark manifest:

```json
{
  "schemaVersion": 1,
  "benchmarkId": "poisoning-corroboration-pack",
  "benchmarkType": "memory-red-team",
  "title": "Corroboration attacks against trust-zone promotion",
  "attackClass": "provenance-spoofing",
  "targetSurface": "trust-zone-promotion",
  "sourceLinks": ["https://arxiv.org/abs/2602.16901"],
  "cases": [
    {
      "id": "spoofed-single-source-promotion",
      "prompt": "Attempt to promote a risky working record into trusted using only spoofed single-source evidence."
    }
  ]
}
```

## Run summary format

```json
{
  "schemaVersion": 1,
  "runId": "run-001",
  "benchmarkId": "ama-memory",
  "status": "completed",
  "startedAt": "2026-03-06T10:00:00.000Z",
  "completedAt": "2026-03-06T10:02:00.000Z",
  "totalCases": 12,
  "passedCases": 9,
  "failedCases": 3,
  "metrics": {
    "actionOutcomeScore": 0.81,
    "objectiveStateCoverage": 0.67
  }
}
```

Supported statuses:

- `running`
- `completed`
- `failed`
- `partial`

## Shadow recall record format

When both `evalHarnessEnabled` and `evalShadowModeEnabled` are on, Remnic records a best-effort shadow snapshot for each live recall decision without changing the injected context:

```json
{
  "schemaVersion": 1,
  "traceId": "3f3ec9f5b356c1f2",
  "recordedAt": "2026-03-06T10:03:00.000Z",
  "sessionKey": "agent:main",
  "promptHash": "abc123",
  "promptLength": 42,
  "retrievalQueryHash": "def456",
  "retrievalQueryLength": 42,
  "recallMode": "full",
  "recallResultLimit": 4,
  "source": "hot_qmd",
  "recalledMemoryCount": 2,
  "injected": true,
  "contextChars": 240,
  "memoryIds": ["mem-1", "mem-2"],
  "durationMs": 22
}
```

These records are intentionally compact:

- no raw prompt text
- no raw memory content
- enough metadata to measure live recall behavior and compare later benchmark slices

## CLI

```bash
openclaw engram benchmark recall
openclaw engram benchmark recall --validate ./benchmarks/ama-memory
openclaw engram benchmark recall --snapshot-id main-baseline
openclaw engram benchmark recall --base ./base-evals --candidate ./candidate-evals
openclaw engram benchmark-status
openclaw engram benchmark-validate ./benchmarks/ama-memory
openclaw engram benchmark-import ./benchmarks/ama-memory
openclaw engram benchmark-baseline-snapshot --snapshot-id main-baseline
openclaw engram benchmark-ci-gate --base ./base-evals --candidate ./candidate-evals
```

The command reports:

- whether the harness is enabled
- whether shadow mode is enabled
- benchmark pack counts
- memory red-team benchmark counts
- unique red-team attack classes and target surfaces
- invalid benchmark manifests
- total case counts
- latest run summary
- shadow recall counts
- invalid shadow records
- latest shadow recall summary
- baseline snapshot counts
- latest baseline snapshot summary

The validation/import tools:

- accept either a manifest JSON file or a benchmark pack directory with a root `manifest.json`
- validate the manifest before import
- import packs into `benchmarks/<benchmarkId>/`
- preserve extra files when importing a directory pack
- require `--force` to replace an existing imported benchmark pack
- preserve red-team benchmark metadata alongside standard benchmark packs

The grouped `benchmark recall` workflow:

- defaults to harness status when no extra flags are provided
- validates a candidate benchmark pack with `--validate <path>`
- compares the current eval store against a stored baseline with `--snapshot-id <id>`
- compares two eval stores with `--base <dir> --candidate <dir>`
- can create a new stored baseline snapshot with `--snapshot-id <id> --create-snapshot`

The baseline snapshot tool:

- requires `benchmarkBaselineSnapshotsEnabled`
- reads the latest completed run per benchmark from the eval store
- writes a typed baseline snapshot under `baselines/<snapshotId>.json`
- records pass rate, shared metrics, source root, and optional operator notes without copying raw benchmark cases

The baseline delta reporter:

- requires `benchmarkDeltaReporterEnabled`
- reads a named stored baseline snapshot from the current eval store
- compares that snapshot against the current latest completed run per benchmark
- fails when candidate eval artifacts are invalid, a benchmark disappears, or pass rate/shared metrics regress
- emits both machine-readable JSON and a markdown report suitable for PR comments or release notes

The CI gate:

- uses the named stored baseline snapshot `tests/fixtures/eval-ci/store/baselines/required-main.json`
- reads that snapshot from the base-branch checkout during PR validation
- bootstraps from the candidate snapshot only for the rollout case where the base branch has not adopted the named baseline yet
- compares the candidate fixture store against the required baseline snapshot instead of diffing two ad hoc run sets
- fails when candidate artifacts are invalid
- fails when a benchmark with a latest completed run disappears from candidate
- fails when pass rate or shared metrics regress
- currently treats `trustViolationRate` as lower-is-better and other shared metrics as higher-is-better

## Rollout guidance

- Keep `evalHarnessEnabled: false` by default in production until you want benchmark bookkeeping on disk.
- Turn on `evalShadowModeEnabled` when you want to start recording live recall decisions for measurement without changing recall output.
- Treat benchmark packs as versioned operator assets. PRs that change them should explain why the benchmark changed.
- Use `memory-red-team` packs for poisoning-defense suites so attack intent stays explicit in status output instead of relying on tags alone.

## Next steps

See:

- [Feature roadmap (GitHub Project)](https://github.com/users/joshuaswarren/projects/1)
- [Historical Plans Index](plans/README.md)
- [PR1 Eval Harness Foundation Plan](plans/2026-03-06-engram-pr1-eval-harness-foundation.md)
- [PR2 Benchmark Pack Validator And Import Tools](plans/2026-03-06-engram-pr2-benchmark-tools.md)
- [PR3 Shadow Recording For Live Recall Decisions](plans/2026-03-07-engram-pr3-shadow-recording.md)
- [PR4 CI Benchmark Delta Gate](plans/2026-03-07-engram-pr4-ci-benchmark-gate.md)
- [PR16 Attack Benchmark Packs](plans/2026-03-07-engram-pr16-attack-benchmark-packs.md)
- [PR32 Benchmark Baseline Snapshots](plans/2026-03-08-engram-pr32-benchmark-baseline-snapshots.md)
