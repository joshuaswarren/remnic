# H6 failure-gate final report

Status: **complete**. Registered study decision: **`NOT_ESTIMABLE`**.

## Answer

This experiment does not support a confirmatory claim that failure memory makes
agents better.

It does show a strong timing signal. On the 17 complete tasks, putting a matched
failure note just before the related action cut repeated failures by 38.04
percentage points versus putting the same note at turn start. The 95% interval
was 18.04 to 59.61 points. The bound v10 pilot found a similar 37.78-point
benefit.

But one main-run row in the pre-action arm was invalid. The preregistration
allows zero primary task cuts. It requires the whole H6-timing result to become
`NOT_ESTIMABLE` when any compared task has an invalid row. The clean 17-task
estimate remains useful, but it is exploratory by the registered rule.

The content comparison failed. At turn start, a matched failure fact did not
beat a matched success fact under the full support rule. It reduced repeated
failures by 4.81 points, but task pass rate fell by 6.30 points. The registered
H6-content decision is `REJECTED`.

So the narrow answer is: pre-action failure notes probably reduce repeated
mistakes, but this run did not prove that they improve task completion or make
the agent better overall.

## Registered questions

H6 separated timing from content before the main run:

1. **H6-timing:** Does a fixed failure note work better just before a matched
   action than at turn start?
2. **H6-content:** At turn start, does a matched failure fact work better than a
   matched success fact?

The preregistration fixed the task split, arms, seeds, model profile, and caps.
It also fixed the analysis seed, bootstrap procedure, support thresholds,
retry rules, and zero-cut rule. Amendment 3 removed H6-content from the launch
power gate. It kept content as a registered primary. Amendment 4 removed the
no-trap pass-rate check from the launch gate. It kept the estimate and original
margin in the report.

The bound v10 pilot estimated H6-timing power at 0.8364 for 18 main tasks. Its
timing point estimate also favored pre-action delivery by 37.78 points. Pilot
results set the main sample size. They do not count as confirmatory evidence.

## Main-run design and execution

The main run used:

- 18 independent synthetic TypeScript tasks
- three run-time variants per task
- five fixed seeds
- five main arms, plus paired no-trap rows for `NO_MEMORY` and
  `PRE_ACTION_FAILURE`
- one frozen Qwen3.5 35B, 32K, no-thinking, Q4_K_M model profile
- 10,000 task-bootstrap and paired-shuffle draws with analysis seed 81

That design produced 1,890 expected final rows:

\[
18\text{ tasks} \times 3\text{ variants} \times 5\text{ seeds}
\times 7\text{ row types} = 1{,}890.
\]

The run completed all 1,890 rows. Of those, 1,888 were valid and two were
invalid. Three host or API faults occurred on first tries and were retried under
the fixed retry rule. No row exhausted its retry allowance. All tries remain in
the checkpoints. The deviation log is empty.

The run used 43,377,443 tokens. Summed episode elapsed time was 167,648,106 ms,
or 46.57 hours. This includes model, tool, and evaluator time. The analysis made
zero judge-model calls.

## Primary results

Benefits are candidate minus baseline, expressed so a positive repeated-failure
benefit favors the candidate.

| Claim | Complete tasks | Repeated-failure benefit | Relative reduction | Task-pass benefit | Raw p | Holm p | Registered decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Timing: pre-action failure vs turn-start failure | 17 | +38.04 pp, 95% CI [18.04, 59.61] | 100%, 95% CI [100, 100] | +2.35 pp, 95% CI [-2.35, 9.41] | 0.00180 | 0.00360 | `NOT_ESTIMABLE` |
| Content: turn-start failure vs turn-start success | 18 | +4.81 pp, 95% CI [0.74, 10.00] | 11.82%, 95% CI [1.52, 26.87] | -6.30 pp, 95% CI [-15.56, 0.74] | 0.93931 compound | 0.93931 | `REJECTED` |

The timing estimate clears every numeric support threshold on the 17 complete
tasks. It still cannot become confirmatory. The zero-cut rule takes precedence
over the point estimate, interval, and adjusted p value.

The content row uses the preregistered compound p value. That value is the worse
of its repeated-failure and task-pass tests. The repeated-failure test alone had
p = 0.06479. The task-pass test had p = 0.93931, which set the compound value.

## Descriptive arm outcomes

These raw episode counts describe the frozen main split before primary
whole-task cuts. The `BOTH` and `NO_MEMORY` arms can help explain the mechanism,
but the preregistration does not let them rescue a failed primary.

| Arm | Valid rows | Repeated failures | Repeated-failure rate | Passing episodes | Episode pass rate |
| --- | ---: | ---: | ---: | ---: | ---: |
| `NO_MEMORY` | 269 | 119 | 44.24% | 7 | 2.60% |
| `TURN_START_SUCCESS` | 270 | 110 | 40.74% | 19 | 7.04% |
| `TURN_START_FAILURE` | 270 | 97 | 35.93% | 2 | 0.74% |
| `PRE_ACTION_FAILURE` | 269 | 0 | 0.00% | 8 | 2.97% |
| `BOTH` | 270 | 0 | 0.00% | 4 | 1.48% |

Pre-action delivery and the `BOTH` arm eliminated the exact repeated-failure
outcome in their valid raw rows. Neither produced the highest episode pass
rate. Turn-start success wording did. The failure interventions often changed
the failure state instead of completing the task.

## No-trap check

The no-trap diagnostic asked whether pre-action failure notes changed behavior
when no matching trap existed.

| Measure | Difference, pre-action minus no memory | Paired 90% interval | Registered margin | Result |
| --- | ---: | ---: | ---: | --- |
| Pass rate | +0.74 pp | [-0.74, 2.22] pp | Strictly inside [-2, 2] pp | Outside margin |
| Mean steps | -0.026 | [-0.063, 0.0037] | Strictly inside [-2, 2] | Inside margin |

The pass-rate interval missed the upper margin by 0.22 percentage points. This
check did not gate main execution after Amendment 4, but the original estimate
and margin remain on the record. The step result gives no sign of added
hesitation.

## Why the study is not estimable

Two final rows received the deterministic `VAGUE_CHECK` invalid reason after
their checks returned `INDETERMINATE`:

- `h6-task-10`, variant 3, seed 4, `PRE_ACTION_FAILURE`: token cap after six steps
- `h6-task-13`, variant 1, seed 1, `NO_MEMORY`: duration cap after two steps, following one transport retry

The first row sits in the H6-timing comparison. The preregistration requires a
whole-task cut when any expected compared cell is invalid. It also permits zero
primary cuts. H6-timing therefore becomes `NOT_ESTIMABLE`. The study-level
mapping makes the whole study `NOT_ESTIMABLE`.

Rerunning either task result would break the frozen retry rule. That rule permits
retries only for host or API faults. Once a try returns a task result, valid or
invalid, the runner must not rerun it. A confirmatory answer now requires a new
manifest and a new run.

## What the data says

Three findings survive careful wording:

1. **Timing has a large descriptive effect in both runs.** The pilot and main
   complete-task estimates were +37.78 and +38.04 points. Both favor delivery
   just before action.
2. **Failure wording at turn start is not enough.** It did not meet the content
   support rule and came with a lower task-pass estimate than success wording.
3. **Fewer repeated failures did not clearly mean more completed tasks.** The
   timing task-pass interval crossed zero. Turn-start success had the highest
   raw episode pass rate at 7.04%; `BOTH` reached only 1.48%.

This makes the mechanism promising for reducing repeated mistakes. It does not
establish an overall agent-quality gain.

## Recommended next experiment

1. Keep pre-action delivery as the main candidate. Do not claim H6 support from
   this run.
2. Register invalid-row handling before collecting new data. Validate cap-driven
   indeterminate checks on the development and pilot splits, then freeze a bounded
   reserve of independent tasks for the main run.
3. Add task-pass non-inferiority to the timing support rule. The current rule can
   support removal of one failure state without proving more task completion.
4. Keep `BOTH` exploratory. It removed repeated failures but passed only 1.48%
   of raw episodes.
5. Drop the turn-start failure-versus-success claim unless the content mechanism
   changes. This run rejected the current version.

## Evidence and reproducibility

| Receipt | Location or value |
| --- | --- |
| Preregistration | `docs/research/failure-gate/preregistration.md` |
| Bound pilot run | `~/.remnic/bench/results/h6-pilot-v10/` |
| Bound pilot manifest artifact hash | `5bce2c0c20fadf77706ae5dbb503d4f938d40e2d4178c5395b36683cfef75e21` |
| Bound pilot power artifact hash | `cfaec22f374b353b536dec6067243a1731804f8f1d8d2f4742e1631cf1b27bd5` |
| Main run | `~/.remnic/bench/results/h6-main-v1/` |
| Main source commit | `32d1c8126a843460bd6ab76ac9fdc7d952b440b7` |
| Main manifest artifact hash | `5143c48937fd4232250f136f22cf76089686f4c964214fdcb262a5a249e71bd3` |
| `statistics.json` SHA-256 | `16fd5af137b2e624693bd95c4bf9f2a93796cfd168594b48e4da7031683876ec` |
| `power.json` SHA-256 | `a0d59d946cc71d6fda9762931a75ff80f609b61bdbecb1bec8b4e3e67a8917ce` |
| `audit.json` SHA-256 | `636a3c6a54d296d74fb36e7d5a1ffca1990b2f6b57dfc16afbda908ea6927968` |
| Deviation log | `deviations.jsonl`, 0 bytes |

The raw pilot and main bundles are operator-local and are not part of the public
repository. These hashes support local audit and tamper checks. Public
reproduction requires a sanitized bundle or an independent rerun.

An operator-local zero-call replay used:

```bash
npx tsx packages/remnic-cli/src/index.ts bench coding repeated-failure stats \
  --run ~/.remnic/bench/results/h6-main-v1
```

It returned:

```json
{"statisticsPath":"statistics.json","rows":1890,"modelCalls":0}
```

The replay reproduced the same `statistics.json`, `power.json`, and `audit.json`
SHA-256 values listed above.
