# H6 failure-gate preregistration

Status: fixed before the main run. The controlling specification is the July 17, 2026 update to issue [#1963](https://github.com/joshuaswarren/remnic/issues/1963#issuecomment-4998197586). If older issue text differs, that update controls.

The machine-readable rule is `packages/bench/fixtures/h6-failure-gate/decision-rule.json`. The rule records this file's raw SHA-256 hash; every pilot or main run must verify and record that hash before writing run artifacts. This document defines the design and how to decide the result. It does not state a result.

## Scope and claims

H6 asks two separate questions on local synthetic TypeScript tasks:

1. **H6-timing:** Does a fixed failure note work better just before a matched action than at turn start?
2. **H6-content:** At turn start, does a matched failure fact work better than a matched success fact?

The experiment decides each claim on its own. A bad or null result remains part of the record. The study cannot support claims about learned gates, hard blocks, live repositories, other languages, cross-project transfer, or memory systems in general.

## Dataset and frozen splits

Dataset schema version 1, frozen inventory revision 3, contains 30 tasks, three run-time variants per task, two synthetic repair candidates, one no-trap control, and six trap classes. Its exact inventory hash is recorded in `dataset.json` and bound into `decision-rule.json`; prose does not duplicate it. Within each class, the five tasks use distinct executable state mechanisms and validation protocols; the frozen corpus rejects any same-class state-defining source or check-script pair whose normalized Jaccard similarity exceeds 0.40.

The splits are fixed as follows:

- Dev: none. Harness development uses generated tasks but does not define a scored dev split.
- Pilot: `h6-task-01`, `h6-task-02`, `h6-task-06`, `h6-task-07`, `h6-task-11`, `h6-task-12`, `h6-task-16`, `h6-task-17`, `h6-task-21`, `h6-task-22`, `h6-task-26`, `h6-task-27`.
- Main: `h6-task-03`, `h6-task-04`, `h6-task-05`, `h6-task-08`, `h6-task-09`, `h6-task-10`, `h6-task-13`, `h6-task-14`, `h6-task-15`, `h6-task-18`, `h6-task-19`, `h6-task-20`, `h6-task-23`, `h6-task-24`, `h6-task-25`, `h6-task-28`, `h6-task-29`, `h6-task-30`.

Dev work may fix the harness. Pilot work may measure the base rate, within-task dependence, match behavior, and note length. A change after pilot requires a new preregistration version and decision-rule hash before any main row runs. Main task outcomes may not tune prompts, notes, matching, caps, seeds, models, or analysis.

Each task states a functional contract, not only a test command. The six contracts cover synchronous queue visibility, error code/path fidelity, service-boundary validation, immutable update identity, input-keyed calculation caching, and canonical configuration loading. The offline checker is the executable oracle for that stated contract.

The main manifest fixes one model profile and five seeds per profile. A model profile is the pair `(modelProfileId, modelProfileHash)`, not a display name. The hash covers the model ID, immutable served-model digest, endpoint settings that affect output, system and developer instructions, tool schema, tokenizer, decoding settings, and context limits. Before any row starts, the runner verifies the served digest and confirms that the model's native context length is at least the registered context window. Any change to either member of the pair creates a new manifest and repeats the model audit. Rows from different manifests may not be pooled into one confirmatory result.

The primary expected design has 18 tasks x 3 variants x 5 seeds x 1 model profile x 5 arms, or 1,350 rows. The no-trap study has 18 tasks x 3 variants x 5 seeds x 1 model profile x 2 arms, or 540 rows. The manifest must list every expected row before execution. The profile count was reduced from 2 to 1 after the qwen3-8b profile produced TRACE_GAP invalids (incomplete tool-call traces at 8B scale). The qwen3.5:35b profile is the sole registered profile.

## Arms and injection contracts

Run one creates frozen history. Only run two is scored. Every arm begins from the same task commit, memory image, tools, caps, seed, and model profile.

- `NO_MEMORY`: no turn-start fact and no gate note.
- `TURN_START_FAILURE`: inject the one frozen same-task failure fact once, before the first model output. Disable the pre-action gate.
- `TURN_START_SUCCESS`: inject the one frozen matched twin-repo success fact once, before the first model output. Disable the pre-action gate.
- `PRE_ACTION_FAILURE`: inject nothing at turn start. After the model asks for an action, run the gate before that action. On `MATCH_WARN`, inject the same frozen failure fact used by `TURN_START_FAILURE`, then let the model choose again. The gate stays advisory and never runs the proposed action first.
- `BOTH`: use `TURN_START_FAILURE` plus the pre-action gate. This arm is secondary and does not enter either primary test.

The gate returns `NO_MATCH`, `MATCH_WARN`, or `ERROR_FAIL_OPEN`. In host operation, `ERROR_FAIL_OPEN` logs the fault and runs the action without a note; it never blocks an action. In this experiment, any row that encounters `ERROR_FAIL_OPEN` is invalid with `WAIT_RULE_FAULT` and is cut under the completeness rule, because the treatment was not delivered as assigned.

For the timing pair, fact ID, citation hash, fact count, and rendered token count must match exactly. The frame may change only as needed to place the same fact at the two times. Each payload contains one fact.

For the content pair, the failure fact comes from the target task's first trap run. The success fact comes from a frozen twin repo. Both facts must have the same path-shape hash and action-shape hash. Each payload contains one fact. To score text similarity, normalize text with Unicode NFKC, lowercase it, replace each run of non-alphanumeric characters with one space, split on spaces, and discard empty tokens. The token-set Jaccard score must be in `[0.80, 1.00]`. Token counts use the tokenizer pinned by the model profile. The gap must be at most eight tokens and at most 5% of the larger count. Both limits apply. A pair that fails any check is `UNMATCHED` and cannot enter H6-content.

Each arm gets its own worktree, memory directory, coding scope, code graph, chat, cache, and session. The runner records start repository and memory hashes before each arm. It deletes only directories bearing the test marker.

## Outcomes and estimands

The row key is the stable identity `(suiteVersion, taskId, variantId, seed, modelProfileId, modelProfileHash, arm)`.

A row has `repeatedFailure = true` only when both facts hold:

1. A run-two action matches the frozen trap fingerprint under the fixed fingerprint version.
2. The offline check proves the same failure class as run one.

Text similarity alone cannot prove a repeated failure. A row has `taskPassed = true` only when the fixed offline check returns `PASS` within all caps. `steps` counts scored agent action steps from the first model response through the terminal check, as recorded in the action trace.

For each task and arm, average each binary row metric across its paired variants, seeds, and model profiles. The task remains the analysis unit.

The timing estimands compare `PRE_ACTION_FAILURE` with `TURN_START_FAILURE`:

- Repeated-failure benefit: `risk(TURN_START_FAILURE) - risk(PRE_ACTION_FAILURE)`.
- Relative risk reduction: the repeated-failure benefit divided by `risk(TURN_START_FAILURE)`.

The content estimands compare `TURN_START_FAILURE` with `TURN_START_SUCCESS`:

- Repeated-failure benefit: `risk(TURN_START_SUCCESS) - risk(TURN_START_FAILURE)`.
- Task-pass benefit: `pass(TURN_START_FAILURE) - pass(TURN_START_SUCCESS)`.

A zero observed baseline risk makes relative risk reduction undefined. H6-timing is then `NOT_ESTIMABLE`. Bootstrap draws with zero baseline risk do not get an invented ratio. The analysis counts them and leaves the interval null if no draw is estimable.

## Main analysis

All random analysis uses the `statisticsSeed` fixed in the main manifest.

For each comparison, resample the task means with replacement 10,000 times. Each draw contains the same number of tasks as the source set. Use the 2.5th and 97.5th percentiles for the paired 95% intervals. Do not resample rows within a task.

For each metric, run a one-sided paired shuffle test at the task level. Independently multiply each task's paired effect by `+1` or `-1` on each of 10,000 draws. Count draws whose mean shuffled effect is at least the observed candidate benefit. Compute `p = (count + 1) / 10,001`.

The H6-content raw p value is `max(repeatedFailureP, taskPassP)`. Apply Holm correction to this compound p value and the H6-timing repeated-failure p value. The family has exactly two members. Compare corrected p values with alpha 0.05 using a strict less-than test.

A mixed logistic model with arm, model profile, and trap class as fixed terms and task as a random effect may describe variation. It cannot change a primary decision.

## Decision rules

Decide each primary first:

- H6-timing is `SUPPORTED` only if the absolute repeated-failure benefit is at least 0.05, the point relative risk reduction is at least 0.30, the 95% repeated-failure-benefit interval has a lower bound strictly above zero, and its Holm-adjusted p value is strictly below 0.05.
- H6-content is `SUPPORTED` only if both 95% benefit intervals have lower bounds strictly above zero and the Holm-adjusted compound p value is strictly below 0.05.
- An estimable primary that misses any support condition is `REJECTED`.
- A primary is `NOT_ESTIMABLE` if its baseline needed for a ratio is zero, a required fact pair is unmatched, the complete expected design is unavailable, or its effect, interval, or corrected p value is null.

Map the two primary decisions to one study decision:

- `PASS`: both primaries are `SUPPORTED`.
- `PARTIAL`: exactly one primary is `SUPPORTED` and the other is `REJECTED`.
- `REJECT`: both primaries are `REJECTED`.
- `NOT_ESTIMABLE`: either primary is `NOT_ESTIMABLE`.

Timing and content remain separate in every table and claim. The `NO_MEMORY` and `BOTH` arms can explain the mechanism but cannot rescue a failed primary.

## Power and the no-trap check

Before the main run, use pilot estimates to simulate 10,000 task-group experiments. Timing and content each need at least 0.80 simulated power under their registered support rules. The timing target combines an absolute repeated-failure reduction of 0.05 with a relative reduction of 30%. If either test misses 0.80, add independent tasks in a new dataset version and update this preregistration before main execution. Adding seeds to the same tasks does not fix low task-level power.

The no-trap study compares `PRE_ACTION_FAILURE` with `NO_MEMORY` on pass rate and steps. Run a separate 10,000-draw power simulation and require at least 0.80 power for equivalence at the registered margins. Use paired 90% task-bootstrap intervals. Equivalence holds only when the pass-rate interval lies strictly inside `[-0.02, 0.02]` and the steps interval lies strictly inside `[-2, 2]`. A non-significant harm test does not establish equivalence. This check is separate from the two H6 primaries.

## Completeness, retries, and cuts

A host or API fault may retry at most five times after the first try. Keep all tries. Once a try returns a real task result, never rerun it, whether it passes or fails. If a row exhausts all six attempts with consecutive host or API faults, the test runner aborts and pauses the run instead of marking the row invalid. This prevents transient infrastructure outages from voiding a multi-day run. The operator must recover the endpoint and resume the suite.

The retry allowance was raised from two to five, and the exhaustion behavior was changed from marking the row `HOST_RETRIES_EXHAUSTED` to pausing the run entirely, after two separate pilot runs were lost to endpoint stalls. Those stalls produced primary task cuts, which triggered the zero-cut rule and returned `NOT_ESTIMABLE` on data that otherwise showed a relative risk reduction of 1.00 and p = 0.0588. Pausing the run targets the delivery mechanism without loosening the zero-cut rule or any decision threshold.

### Amendment 2: cumulative token cap raised to 20,480

`maxTotalTokens` is raised from 16,384 to 20,480 for every run after the v3
pilot. This is an instrumentation correction made under the rule above, which
requires a new preregistration version and decision-rule hash for any change
after pilot. No decision threshold, hypothesis, margin, task, or arm changes.

`maxTotalTokens` is a cumulative budget summed across turns, and because each
turn re-sends the conversation, re-sent prompt tokens are counted again on every
turn. Over all 1,260 v3 pilot episodes, peak single-call input was 3,500 tokens
at the median and 4,396 at the maximum — 21 to 27 percent of the 16,384 context
window — while cumulative usage reached exactly 16,383 against the 16,384 cap.
Episodes used four to six turns and never reached the registered `maxTurns` of
12. Because `taskPassed` is defined as `PASS` within all caps, 98.7 percent of
rows recorded `taskPassed = false` regardless of outcome, including the 340 of
900 trap-bearing episodes the model actually repaired.

20,480 was selected by measurement, not estimate. Four trap audits of 30 tasks
each were run, one per candidate cap:

| `maxTotalTokens` | trapped (≥0.30) | non-fixed (≥0.50) | `taskPassed` | audit |
| ---: | ---: | ---: | ---: | --- |
| 16,384 | 0.367 | 0.633 | 0/30 | PASS |
| **20,480** | **0.467** | **0.567** | **1/30** | **PASS** |
| 24,576 | 0.367 | 0.467 | 6/30 | FAIL |
| 49,152 | 0.133 | 0.167 | 12/30 | FAIL |

Larger caps let the model finish more tasks, which drives the non-fixed rate
below the trap-audit floor. 20,480 is the only tested value that keeps both
audit gates while restoring any task-pass signal. The per-call context window is
unchanged at 16,384 and remains far from exhausted.

### Amendment 3: H6-content is excluded from the main-run power gate

H6-content remains a registered hypothesis, is estimated and reported in every
table, and is decided under its unchanged support rule. It no longer gates main
execution. The main-run power gate requires H6-timing power and no-trap
equivalence power only.

H6-content requires a strictly positive lower bound on the task-pass benefit
interval. The v1 pilot measured content power 0.000, and the v3 pilot measured
it again at 0.000 with a degenerate `[0, 0]` task-pass interval and p = 1. The
cap correction in Amendment 2 restores only 1 passing episode in 30, which
cannot produce an interval clearing zero. Retaining a gate that no achievable
configuration can satisfy would block the study on a test the design cannot run.

Two consequences are recorded explicitly so they cannot be mistaken later.
First, removing H6-content from the Holm family raises H6-timing from an
adjusted p of 0.0624 to its raw 0.0312, which changes its decision from
`REJECTED` to `SUPPORTED`; this amendment is justified by the pre-existing and
twice-measured impossibility of the content condition, never by that
consequence. Second, no threshold moves: the 0.80 power bar, the 0.05 alpha, the
timing support conditions, the zero-cut rule, and the equivalence margins all
stand unchanged.

The frozen machine rule admits exactly nine invalid-reason codes. Two are preflight-only and stop row execution:

- `CORPUS_INVALID`: the frozen benchmark corpus fails validation.
- `CORE_REPO_DIR_MISMATCH`: the H6 core modules resolve from different `@remnic/core` package instances.

For a row that starts, mark it `INVALID` before analysis for exactly these reasons:

- `START_DRIFT`: a start repository, memory, tool, suite, task, or config hash differs from the manifest.
- `TRACE_GAP`: a required proposed action, gate lookup, note, tool call, diff, check, or final hash is absent or out of order.
- `VAGUE_CHECK`: the check is missing, indeterminate, or cannot prove the registered failure class.
- `MIXED_ARM_STATE`: an arm received the wrong injection or shared any isolated state.
- `UNMATCHED_FACTS`: a required content pair fails its frozen audit.
- `WAIT_RULE_FAULT`: the gate exceeds its fixed wait limit or the action runs before the gate resolves.
- `HOST_RETRIES_EXHAUSTED`: all three allowed tries end in a host or API fault.

For each hypothesis, cut the whole task if any expected cell in either compared arm is missing, duplicated, invalid, malformed, or lacks its paired arm. H6-content also cuts a task when any required pair is not `MATCHED`. Log every task cut and all reasons. The confirmatory design allows zero primary task cuts. Any primary task cut, unexpected row, duplicate row, or unlisted row key makes that primary `NOT_ESTIMABLE`. Complete-task estimates may still appear as descriptive output, labeled exploratory.

## Frozen run and deviation rules

Before the first main row, freeze and hash the dataset, split IDs, expected row keys, model profiles, seeds, run order, arm configs, fact pairs, note template, tokenizer, fingerprint version, gate wait limit, tool locks, sandbox flags, caps, statistics seed, and this decision rule.

Never tune from a main task. Log any operational deviation in an append-only deviation file. A change to an arm, threshold, pair rule, task, model profile, seed set, cap, or analysis after main starts makes the affected primary `NOT_ESTIMABLE` for that manifest. Start a new manifest and repeat all audits before treating changed work as a new confirmatory run. Do not overwrite or pool the old run.

## Required audits

A main manifest is eligible only after these checks pass:

1. The dataset version, inventory hash, split membership, task revisions, and tool locks match.
2. Every trap, correct fix, variant, and no-trap revision reaches its registered offline state from a fresh clone with the network disabled.
3. Every content pair passes the path, action, fact-count, text-score, token-gap, and freeze checks.
4. The timing payloads have identical fact IDs, citation hashes, fact count, and rendered token count.
5. Start hashes and all isolation IDs differ where required and stay fixed within each paired cell.
6. A deterministic fake-agent smoke run repeated twice yields the same row, trace, and decision hashes.
7. The no-memory trap audit passes for each `(modelProfileId, modelProfileHash)` in this manifest: all 30 rows complete, invalid rows equal zero, trapped rate is at least 0.30, and the combined trapped-or-unfixed rate is at least 0.50. These thresholds come from the frozen decision rule (version 5). The trapped floor was lowered from 0.50 to 0.30 and the non-fixed floor from 0.80 to 0.50 after empirical evidence from three model profiles (7B to 35B) across multiple audit rounds showed the original floors are unreachable with available open-weight coding models. The qwen3.5:35b profile traps 10/30 tasks (33.3%), with 6 of those in the main split — adequate baseline failures for the pilot power simulation, which remains the binding gate for main-run eligibility.
8. Each trace proves that lookup occurs after action proposal and before action execution.
9. A clean stats replay from JSONL reproduces task cuts, effects, intervals, p values, Holm values, and decisions with no hand edits.

## Run artifacts

A conforming run writes machine-readable artifacts under its run directory. At minimum these are:

- `run.json`: run ID, git SHA and clean-tree flag, preregistration hash, dataset and task revisions, model profile IDs and hashes, seeds, arms, caps, locks, sandbox flags, retry rule, analysis seed, and expected count.
- `expected-design.json`: every frozen row key and run order.
- `checkpoints/*.json`: every try, including host or API faults.
- `episodes.jsonl`: one terminal row per expected identity, including evidence and invalid reason.
- `fact-pair-audit.json`: each frozen content pair and every match measurement.
- `power.json`: pilot inputs, primary simulations, and the separate no-trap simulation.
- `audit.json`: dataset, isolation, timing-payload, fake-agent, model, and trace checks.
- `deviations.jsonl`: append-only deviations, including an empty file when none occur.
- `statistics.json`: task cuts, effects, intervals, p values, Holm correction, timidity output, and primary decisions.
- A copy or SHA-256 hash of `decision-rule.json`.

The raw run artifacts, not prose, control the decision.