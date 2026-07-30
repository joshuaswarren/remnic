# H6 failure-gate preregistration

Status: fixed before the main run. The controlling specification is the July 17, 2026 update to issue [#1963](https://github.com/joshuaswarren/remnic/issues/1963#issuecomment-4998197586). If older issue text differs, that update controls.

The machine-readable rule is `packages/bench/fixtures/h6-failure-gate/decision-rule.json`. Each run must copy that file or record its SHA-256 hash. This document defines the design and how to decide the result. It does not state a result.

## Scope and claims

H6 asks two separate questions on local synthetic TypeScript tasks:

1. **H6-timing:** Does a fixed failure note work better just before a matched action than at turn start?
2. **H6-content:** At turn start, does a matched failure fact work better than a matched success fact?

The experiment decides each claim on its own. A bad or null result remains part of the record. The study cannot support claims about learned gates, hard blocks, live repositories, other languages, cross-project transfer, or memory systems in general.

## Dataset and frozen splits

Dataset version 1 has inventory hash `770549eabb45423fadbbcd1699865b19605ed4214bc49c8b3f1b11b916d90835`. It contains 30 tasks, three run-two variants per task, and six trap classes.

The splits are fixed as follows:

- Dev: `h6-task-01`, `h6-task-06`, `h6-task-11`, `h6-task-16`, `h6-task-21`, `h6-task-26`.
- Pilot: `h6-task-02`, `h6-task-07`, `h6-task-12`, `h6-task-17`, `h6-task-22`, `h6-task-27`.
- Main: `h6-task-03`, `h6-task-04`, `h6-task-05`, `h6-task-08`, `h6-task-09`, `h6-task-10`, `h6-task-13`, `h6-task-14`, `h6-task-15`, `h6-task-18`, `h6-task-19`, `h6-task-20`, `h6-task-23`, `h6-task-24`, `h6-task-25`, `h6-task-28`, `h6-task-29`, `h6-task-30`.

Dev work may fix the harness. Pilot work may measure the base rate, within-task dependence, match behavior, and note length. A change after pilot requires a new preregistration version and decision-rule hash before any main row runs. Main task outcomes may not tune prompts, notes, matching, caps, seeds, models, or analysis.

The main manifest fixes two model profiles and five seeds per profile. A model profile is the pair `(modelProfileId, modelProfileHash)`, not a display name. The hash covers the model ID and version, endpoint settings that affect output, system and developer instructions, tool schema, tokenizer, decoding settings, and context limits. Any change to either member of the pair creates a new manifest and repeats the model audit. Rows from different manifests may not be pooled into one confirmatory result.

The primary expected design has 18 tasks x 3 variants x 5 seeds x 2 model profiles x 5 arms, or 2,700 rows. The no-trap study has 18 tasks x 3 variants x 5 seeds x 2 model profiles x 2 arms, or 1,080 rows. The manifest must list every expected row before execution.

## Arms and injection contracts

Run one creates frozen history. Only run two is scored. Every arm begins from the same task commit, memory image, tools, caps, seed, and model profile.

- `NO_MEMORY`: no turn-start fact and no gate note.
- `TURN_START_FAILURE`: inject the one frozen same-task failure fact once, before the first model output. Disable the pre-action gate.
- `TURN_START_SUCCESS`: inject the one frozen matched twin-repo success fact once, before the first model output. Disable the pre-action gate.
- `PRE_ACTION_FAILURE`: inject nothing at turn start. After the model asks for an action, run the gate before that action. On `MATCH_WARN`, inject the same frozen failure fact used by `TURN_START_FAILURE`, then let the model choose again. The gate stays advisory and never runs the proposed action first.
- `BOTH`: use `TURN_START_FAILURE` plus the pre-action gate. This arm is secondary and does not enter either primary test.

The gate returns `NO_MATCH`, `MATCH_WARN`, or `ERROR_FAIL_OPEN`. On `ERROR_FAIL_OPEN`, it logs the fault and runs the action without a note. It never blocks an action.

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

- H6-timing is `SUPPORTED` only if the point relative risk reduction is at least 0.30, the 95% repeated-failure-benefit interval has a lower bound strictly above zero, and its Holm-adjusted p value is strictly below 0.05.
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

Before the main run, use pilot estimates to simulate 10,000 task-group experiments. Timing and content each need at least 0.80 simulated power under their registered support rules. The timing target is a 30% relative reduction. If either test misses 0.80, add independent tasks in a new dataset version and update this preregistration before main execution. Adding seeds to the same tasks does not fix low task-level power.

The no-trap study compares `PRE_ACTION_FAILURE` with `NO_MEMORY` on pass rate and steps. Run a separate 10,000-draw power simulation and require at least 0.80 power for equivalence at the registered margins. Use paired 90% task-bootstrap intervals. Equivalence holds only when the pass-rate interval lies strictly inside `[-0.02, 0.02]` and the steps interval lies strictly inside `[-2, 2]`. A non-significant harm test does not establish equivalence. This check is separate from the two H6 primaries.

## Completeness, retries, and cuts

A host or API fault may retry at most two times after the first try. Keep all tries. Once a try returns a real task result, never rerun it, whether it passes or fails. After three host or API faults, mark the row `HOST_RETRIES_EXHAUSTED`.

Mark a row `INVALID` before analysis for exactly these reasons:

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
7. The no-memory trap audit passes for each `(modelProfileId, modelProfileHash)` in this manifest.
8. Each trace proves that lookup occurs after action proposal and before action execution.
9. A clean stats replay from JSONL reproduces task cuts, effects, intervals, p values, Holm values, and decisions with no hand edits.

## Run artifacts

A conforming run writes machine-readable artifacts under its run directory. At minimum these are:

- `run.json`: run ID, git SHA and clean-tree flag, dataset and task revisions, model profile IDs and hashes, seeds, arms, caps, locks, sandbox flags, retry rule, analysis seed, and expected count.
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