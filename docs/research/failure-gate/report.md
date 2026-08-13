# H6 failure-gate final report

Status: **complete, two registered runs.**
First registration (decision rule v12): **`NOT_ESTIMABLE`**.
Timing rerun registration (decision rule v13): **`PASS`. H6-timing `SUPPORTED`, confirmatory.**

## Answer

A matched failure note delivered just before the related action stops an
agent from repeating a known mistake. The confirmatory rerun measured a
repeated-failure reduction of 35.56 percentage points against turn-start
delivery of the same note. The 95% interval is 16.67 to 55.93 points. The
relative risk reduction is 100%, with p = 0.0019. The full 18-task design
completed with zero cuts, zero imputations, and zero invalid rows. This is
the third consistent measurement of the effect. The bound pilot estimated
37.78 points. The first main run estimated 38.04 points on its 17 complete
tasks.

The claim stays narrow. Timing is what worked. The same failure fact at turn
start did not beat a matched success fact under the first registration's
content rule (`REJECTED`). Fewer repeated failures also did not prove more
completed tasks. The rerun's task-pass benefit was +1.48 points
with an interval touching zero. Pre-action failure memory removes a known
failure mode; it does not make the agent better overall.

The first registration ended `NOT_ESTIMABLE`: one cap-terminated pre-action
row returned an unclassifiable check, and the v12 rule allowed zero primary
task cuts. The rerun registration fixed that rule before any new data existed. An
unclassifiable check now scores worst-case against the pre-action arm
instead of voiding the study. The rerun then re-measured on new seeds. The scoring
change was never exercised: no rerun row needed it.

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

## Why the first registration is not estimable

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

## Timing rerun registration

The rerun is a second registration of the same study, fixed before any rerun
row executed: `preregistration-timing-rerun.md` (SHA-256
`4cf775705060d53f37fdc993f5a081d3b68b1646b47f9091889f4ecf2e4b2676`) and
decision rule version 13
(`df345592bcf156f6e5404fc06b11fbb3e3f9f82a54151fae9e15282f3f883d19`). It
decides H6-timing alone.

The design keeps the same 18 main tasks, 3 variants, and model profile as
the first registration. It runs 2 arms (`TURN_START_FAILURE`,
`PRE_ACTION_FAILURE`) on new seeds 6 through 10, for 540 expected rows. The
support thresholds, caps, retry rule, statistics seed, and draw counts are
unchanged. Three things changed. A `VAGUE_CHECK` row is scored worst-case
against the pre-action arm instead of cutting the task. The hypothesis
family has one member. The bound pilot's power evidence transfers by pinned
artifact hashes, and the current harness must replay the pilot's statistics
and power byte-for-byte before any row runs. Zero-cut handling for every
other invalid reason is unchanged.

Two manifests executed under this registration:

1. The first manifest completed all 540 rows cleanly, then crashed in the
   statistics step: a harness defect passed a full-design analysis option
   into the timing-only analysis, whose guard rejects it. The frozen resume
   contract binds a run to the exact harness that started it, so the fixed
   harness cannot finish that run directory and the buggy one cannot compute
   its statistics. The run is preserved with an operational deviation record.
   Its episode log had been written by the crashed finalization attempts, so
   raw arm-level outcomes existed on disk; they were never statistically
   analyzed before the re-execution decision, and only aggregate final-state
   counts without arm attribution were observed during supervision.
   Descriptive rates computed afterward for transparency: 100/270 turn-start
   repeated failures against 0/270 pre-action, a LARGER effect than the kept
   manifest's 96/270 against 0/270, so selection between manifests cannot
   explain the result. The fix landed with a finalization test that runs the
   whole pipeline, and the frozen v12 analysis was shown byte-identical
   before relaunch.
2. The second manifest (`h6-51d25af1ed731c35a94c28fe`) completed all 540 rows
   and finalized. Zero invalid rows, zero task cuts, zero imputations, zero
   unretried host faults, empty deviation log.

## Rerun result

| Claim | Complete tasks | Repeated-failure benefit | Relative reduction | Task-pass benefit | Raw p | Adjusted p | Registered decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Timing: pre-action failure vs turn-start failure | 18 | +35.56 pp, 95% CI [16.67, 55.93] | 100%, 95% CI [100, 100] | +1.48 pp, 95% CI [0.00, 4.44] | 0.0019 | 0.0019 | `SUPPORTED` |

Every registered support condition holds on the complete design: the absolute
benefit clears 0.05, the point relative risk reduction clears 0.30, the
interval lower bound is above zero, and the adjusted p value is below 0.05.
The pre-action arm repeated zero known failures in 270 valid rows; the
turn-start arm repeated them at a 35.56% task-level rate. The study decision
maps to **`PASS`**, and the generated paper report records the run as
**`CONFIRMATORY`** with no ineligibility reasons.

After the run finalized, generating the paper report exposed four defects in
the report layer itself. One eligibility check compared the transferred
pilot's decision-rule hash against the rerun's rule. One compared a full git
SHA to a short one and could never pass. The power-evidence schema was
missing the emitted `requiredPower` field. A schema gate still enforced the
pre-Amendment-3 content power floor. All four were fixed and the report was
regenerated. The decision artifacts were never touched: `statistics.json`,
`power.json`, and `audit.json` are the finalization-time originals, the
statistics replay is byte-identical under the fixed harness with zero model
calls, and the report records the executing and rendering harness hashes
side by side.

## What the data says

1. **Pre-action delivery of failure memory prevents repeated failures.** The
   effect is confirmatory in the rerun (+35.56 points, p = 0.0019) and
   consistent across the pilot (+37.78) and the first run (+38.04).
2. **Failure wording at turn start is not enough.** It did not meet the first
   registration's content support rule and came with a lower task-pass
   estimate than success wording.
3. **Fewer repeated failures did not prove more completed tasks.** The rerun
   task-pass interval touches zero. The claim is failure-mode removal, not
   overall agent improvement.

## Evidence and reproducibility

| Receipt | Location or value |
| --- | --- |
| First preregistration | `docs/research/failure-gate/preregistration.md` |
| Rerun preregistration | `docs/research/failure-gate/preregistration-timing-rerun.md`, SHA-256 `4cf775705060d53f37fdc993f5a081d3b68b1646b47f9091889f4ecf2e4b2676` |
| Rerun decision rule | `packages/bench/fixtures/h6-failure-gate/decision-rule-timing.json`, SHA-256 `df345592bcf156f6e5404fc06b11fbb3e3f9f82a54151fae9e15282f3f883d19` |
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
| Rerun (confirmatory) | `~/.remnic/bench/results/h6-timing-v2/`, run `h6-51d25af1ed731c35a94c28fe` |
| Rerun executing commit | `73761fd4749ee435f60a890eb0a8ee1f0d9aa44a` |
| Rerun `statistics.json` SHA-256 | `0cedc1b861a356ec7f4d8eb9de0e0a15ef76c0c5b1b119fdd72c480f6e53d203` |
| Rerun `power.json` SHA-256 | `2f1630c76b0e38185c05a0014b26d042a1fd5dc87a655143ab1a604bdd56c3bc` |
| Rerun `audit.json` SHA-256 | `38e14e5a2a865aae2d271e9a7bfafa7a020cd32515791dd0a1a086e65f98d3e0` |
| Rerun deviation log | `deviations.jsonl`, 0 bytes |
| Abandoned rerun manifest | `~/.remnic/bench/results/h6-timing-v1/`, operational deviation recorded, never analyzed |

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

The rerun replays the same way:

```bash
npx tsx packages/remnic-cli/src/index.ts bench coding repeated-failure stats \
  --run ~/.remnic/bench/results/h6-timing-v2
```

It returned:

```json
{"statisticsPath":"statistics.json","rows":540,"modelCalls":0,"harnessProvenanceMatchesRun":false}
```

`harnessProvenanceMatchesRun: false` records that the replaying harness is
newer than the executing one, because it carries the post-run report-layer
fixes, while the statistics still reproduce byte-for-byte. The paper report at
`~/.remnic/bench/results/h6-timing-v2/paper/report.md` records the run as
`CONFIRMATORY` and prints both harness hashes side by side.
