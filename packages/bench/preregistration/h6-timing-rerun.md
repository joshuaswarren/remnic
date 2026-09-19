# H6 timing rerun preregistration

Status: fixed before any rerun row executes. This is the second registered run
of the H6 failure-gate study. It decides one hypothesis, H6-timing, on new
data. The machine-readable rule is
`packages/bench/fixtures/h6-failure-gate/decision-rule-timing.json`, decision
rule version 13. The rule records this file's raw SHA-256 hash; the runner
verifies that hash before writing any run artifact. This document defines the
design and how to decide the result. It does not state a result.

## Why a second run exists

The first main run (decision rule version 12) completed all 1,890 rows. Its
timing comparison produced a repeated-failure benefit of 38.04 points on the
17 complete tasks, but one pre-action row on `h6-task-10` was invalid with
`VAGUE_CHECK` after a token-cap termination. Version 12 allowed zero primary
task cuts, so H6-timing was `NOT_ESTIMABLE` by rule. The first run's retry
rule forbids rerunning any returned task result, so a confirmatory answer
requires a new manifest and new rows. That is this run.

The content hypothesis is not part of this run. Version 12 decided it:
`REJECTED`. The no-trap check is not part of this run. Version 12 measured it
on 540 no-trap rows; the steps interval sat inside its margin and the
pass-rate question was recorded as unresolved by that design. Neither question
is reopened here, and this run cannot change either answer.

## The question

**H6-timing:** Does a fixed failure note work better just before a matched
action than at turn start?

## Design

- 18 main-split tasks, the same frozen split as version 12
- 3 run-time variants per task
- 2 arms: `TURN_START_FAILURE` and `PRE_ACTION_FAILURE`
- 5 seeds: **6, 7, 8, 9, 10**
- 1 model profile: `h6-qwen35-35b-32k-nothink-q4km-v4`, the same
  `(modelProfileId, modelProfileHash)` pair as version 12
- no no-trap rows

Expected rows: 18 x 3 x 5 x 2 = **540**. The manifest lists every expected row
before execution.

The seeds are new. Seeds 1 through 5 produced the first run's episodes; reusing
them would remeasure the same trajectories under rules chosen after those
trajectories were seen. Seeds 6 through 10 produce episodes that do not exist
when this rule freezes.

Everything else carries over from version 12 unchanged: the dataset inventory
hash, task revisions, variant set, arm injection contracts for the timing
pair, prompt contract, tool locks, sandbox flags, caps (including the 20,480
cumulative token cap from Amendment 2), the retry rule (five host-fault
retries, then pause; never rerun a returned task result), statistics seed 81,
and 10,000 bootstrap and shuffle draws.

## Outcomes and analysis

Row outcomes, task-level averaging, the bootstrap, and the shuffle test are
unchanged from version 12. The estimands are unchanged:

- Repeated-failure benefit: `risk(TURN_START_FAILURE) - risk(PRE_ACTION_FAILURE)`
- Relative risk reduction: the benefit divided by `risk(TURN_START_FAILURE)`

The hypothesis family has exactly one member, so the Holm-adjusted p value
equals the raw p value. The support rule is unchanged from version 12:
H6-timing is `SUPPORTED` only if the absolute repeated-failure benefit is at
least 0.05, the point relative risk reduction is at least 0.30, the 95%
benefit interval's lower bound is strictly above zero, and the adjusted p
value is strictly below 0.05. An estimable result that misses any condition is
`REJECTED`. A zero observed baseline risk makes the ratio undefined and the
result `NOT_ESTIMABLE`.

The study decision maps directly: `SUPPORTED` gives `PASS`, `REJECTED` gives
`REJECT`, `NOT_ESTIMABLE` stays `NOT_ESTIMABLE`.

## Invalid rows

This is the one scoring change from version 12, and it is fixed here before
any row runs.

A row invalid with `VAGUE_CHECK` — the offline check is missing, returns
`INDETERMINATE`, or cannot prove the registered failure class — is **scored,
not cut**. It takes the worst value for the pre-action arm on every metric:

- in `PRE_ACTION_FAILURE`: `repeatedFailure = true`, `taskPassed = false`
- in `TURN_START_FAILURE`: `repeatedFailure = false`, `taskPassed = true`
- `steps = 0` in either arm; steps feed no timing decision

Every imputed row is listed in `statistics.json` with its task, arm, seed, and
variant. This scoring can only shrink the measured benefit and the relative
risk reduction, so it cannot manufacture support, and it removes the failure
mode that voided the first run: a cap-terminated episode whose check cannot
classify the final repository state. The `taskPassed` imputation points the
same direction. The pre-action arm records a failure and the turn-start arm
records a pass, so the reported task-pass benefit can only move against the
pre-action arm.

Every other invalid reason — `START_DRIFT`, `TRACE_GAP`, `MIXED_ARM_STATE`,
`WAIT_RULE_FAULT`, `UNMATCHED_FACTS`, `HOST_RETRIES_EXHAUSTED` — means the
treatment or its evidence chain was not delivered as assigned. Those rows
still cut the whole task, the design still allows zero primary task cuts, and
any cut makes H6-timing `NOT_ESTIMABLE`. None of these occurred in the first
run's 1,890 rows.

## Power and pilot evidence

The binding pilot is the version 12 bound pilot run, transferred by artifact
hash rather than rerun. The decision rule pins:

- pilot run ID `h6-a30b5cb7dc9174e31329195d`
- manifest artifact hash `5bce2c0c20fadf77706ae5dbb503d4f938d40e2d4178c5395b36683cfef75e21`
- power artifact hash `cfaec22f374b353b536dec6067243a1731804f8f1d8d2f4742e1631cf1b27bd5`
- the pilot's decision-rule hash, preregistration hash, harness source hash,
  and analysis version as recorded in its immutable manifest
- simulated H6-timing power **0.8364** at 18 main tasks, against the required
  0.80

Before any rerun row executes, the runner re-verifies the pilot bundle: the
manifest artifact hashes must match, the pilot's own frozen version 12 rule
must hash to the pinned value, and the pilot's statistics and power artifacts
must replay byte-identically from its immutable rows under the current
harness. The replay proves the harness changes that added this mode did not
alter the frozen analysis. The gate is timing power alone; this design has no
content or no-trap rows to power.

The design quantities that drove the pilot simulation — task count, variants,
seeds per task, arms, caps, model profile — are identical to the version 12
main design on the timing pair, so the transferred power estimate applies to
this run as registered.

## Execution requirements

1. The trap audit must be re-run for the registered model profile under the
   current harness source hash and decision rule version 13 hash, and must
   pass the unchanged thresholds, before any main row runs.
2. The manifest freezes the dataset, split, expected row keys, run order,
   model profile, seeds, arm configs, note template, caps, statistics seed,
   and this rule, exactly as version 12 froze them.
3. A deterministic fake-agent smoke run repeated twice must yield identical
   row, trace, and decision hashes before live rows run.
4. Any operational deviation goes in the append-only deviation file. A change
   to an arm, threshold, task, model profile, seed set, cap, or analysis after
   the first main row makes the run `NOT_ESTIMABLE` for this manifest.
5. Rows from this manifest are never pooled with version 12 rows in any
   confirmatory claim. The first run's estimates remain on its own record.

## Run artifacts

The run writes the same machine-readable artifacts as version 12: `run.json`,
`expected-design.json`, `checkpoints/`, `episodes.jsonl`, `fact-pair-audit.json`,
`power.json`, `audit.json`, `deviations.jsonl`, `statistics.json`, and the
frozen copy of `decision-rule-timing.json`. The raw artifacts, not prose,
control the decision.
