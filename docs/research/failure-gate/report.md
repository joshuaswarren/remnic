# H6 failure-gate report

Status: **pilot complete. Study decision: REJECT. Main run blocked by insufficient power.**

## Pilot result

630 episodes completed across 6 pilot-split tasks, 3 variants, 5 seeds, 1 profile, 5 arms. Zero invalid rows.

### H6-timing (PRE_ACTION_FAILURE vs TURN_START_FAILURE)

| Metric | Value | Threshold | Result |
| --- | ---: | ---: | --- |
| Relative risk reduction | 1.000 (100%) | ≥ 0.30 | PASS |
| Absolute benefit | 0.244 | ≥ 0.05 | PASS |
| Benefit 95% CI | [0.000, 0.511] | lower > 0 | FAIL |
| Raw p-value | 0.248 | < 0.05 | FAIL |
| Holm-adjusted p | 0.496 | < 0.05 | FAIL |
| Decision | REJECTED | | |
| Simulated power | 0.588 | ≥ 0.80 | FAIL |

The pre-action gate eliminated 100% of repeated failures (RRR = 1.0). The effect is large and directionally consistent with H6. But with 6 tasks, the p-value cannot reach significance. The 95% CI includes zero.

### H6-content (TURN_START_FAILURE vs TURN_START_SUCCESS)

| Metric | Value | Threshold | Result |
| --- | ---: | ---: | --- |
| Repeated-failure benefit | -0.022 | > 0 | FAIL |
| Task-pass benefit | 0.000 | > 0 | FAIL |
| Decision | REJECTED | | |
| Simulated power | 0.000 | ≥ 0.80 | FAIL |

Failure memory at turn start is not better than success memory. The effect is slightly negative. This is a genuine negative result for the content hypothesis.

### Timidity (PRE_ACTION_FAILURE vs NO_MEMORY)

| Metric | Value | Threshold | Result |
| --- | ---: | ---: | --- |
| Pass-rate difference | 0.000 | inside [-0.02, 0.02] | PASS |
| Steps difference | 0.000 | inside [-2, 2] | PASS |
| Equivalent | true | | PASS |
| Simulated power | 1.000 | ≥ 0.80 | PASS |

The pre-action gate does not cause timidity. No difference in pass rate or steps compared to no memory.

### Study decision: REJECT

Both primaries are REJECTED. The timing test shows a large directional effect (RRR = 100%) but is underpowered at 6 tasks. The content test shows no effect in the predicted direction.

## Power and the main run

Both primaries miss the 0.80 power threshold. Per the preregistration: "If either test misses 0.80, add independent tasks in a new dataset version and update this preregistration before main execution." Adding seeds to the same tasks does not fix task-level power.

A confirmatory main run requires a new dataset version with more independent tasks — particularly trap-effective tasks that produce baseline failures for the timing comparison.

## What changed from v3 to v6

| Parameter | v3 | v6 | Justification |
| --- | --- | --- | --- |
| Trapped rate floor | 0.50 | 0.30 | Best model traps 30-40% |
| Non-fixed rate floor | 0.80 | 0.50 | Every model fixes 40-77% |
| Model profile count | 2 | 1 | qwen3-8b produces TRACE_GAP invalids |
| Episode duration cap | 120s | 600s | 35B model needs ~200s/episode |

## Artifacts

- Audit: `docs/research/data/pre-action-gate/model-audit-v12/`
- Pilot run: `~/.remnic/bench/results/h6-pilot-v1/`
- Statistics: `~/.remnic/bench/results/h6-pilot-v1/statistics.json`
- Power: `~/.remnic/bench/results/h6-pilot-v1/power.json`
- Episodes: `~/.remnic/bench/results/h6-pilot-v1/episodes.jsonl`
