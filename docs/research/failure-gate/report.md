# H6 failure gate — pilot report

Status: **v8 pilot complete (1260/1260 rows, zero invalid, zero host faults).
Timing power gate met at 0.9499. Main run blocked by no-trap equivalence.**

Run: `h6-pilot-v8`, dataset inventory `687615b5…`, decision rule `39952d63…`,
model profile `h6-qwen35-35b-32k-nothink-q4km-v4` (audit `c581ecef…`, PASSED),
12 pilot tasks, 5 seeds, 5 arms, 3 variants. Zero task cuts.

## Power simulation — the gate on the main run

Ten thousand task-group bootstrap experiments, each resampling 18 tasks from the
12-task pilot population.

| Test | v3 pilot | **v8 pilot** | Required | Verdict |
| --- | ---: | ---: | ---: | --- |
| H6-timing | 0.8363 | **0.9499** | 0.80 | **PASS** |
| H6-content | 0.0000 | 0.0025 | 0.80 | FAIL (no longer gates — Amendment 3) |
| No-trap equivalence | 0.1627 | **0.1311** | 0.80 | **FAIL** |

Under Amendment 3 the gate is timing and no-trap equivalence only, so the main
run is blocked by equivalence alone.

**The registered timing-power objective is met, with margin.** Timing rose from
0.8363 to 0.9499 after the Amendment 2 cap correction and the 32k context fix.
The current dataset carries enough trap-effective independent tasks for timing;
no new dataset version is needed for that test. That question is closed.

### Why v8 supersedes v3 and v7

The v3 pilot ran at `maxTotalTokens` 16,384, where 98.7 percent of rows recorded
`taskPassed = false` regardless of outcome. Amendment 2 raised the cap to 20,480.

A v7 pilot at that cap was abandoned at 320 rows. Its profile used a 49,152-token
context, whose KV cache pushed roughly 1 GB of a mixture-of-experts model off the
GPU. Because MoE routing gathers experts per token, that 4 percent spill cost 98
percent of generation throughput — 2.12 tok/s against 138.60 tok/s at 32,768
tokens, measured directly with all other settings held constant. Requests then
exceeded the 180-second timeout, three rows livelocked at ten retry attempts, and
the run could not have finished. The v8 profile changes exactly two fields from
the audited v7 profile — `contextWindowTokens` and `id` — so no experimental
condition moved, and it was re-audited before use (trapped 11/30, non-fixed
20/30, invalid 0).

v8 then ran 1260 rows with **zero host faults and zero retries**, producing 151
passing episodes against v3's 17.

## Pilot decisions

| Hypothesis | Decision |
| --- | --- |
| H6-timing | REJECTED |
| H6-content | REJECTED |
| Study | **REJECT** |

### H6-timing — every support condition met except multiplicity

| Quantity | Value | Requirement | Met |
| --- | ---: | --- | --- |
| Absolute repeated-failure benefit | 0.3167 | ≥ 0.05 | yes |
| Relative risk reduction | 1.0000 | ≥ 0.30 | yes |
| 95% benefit interval | [0.100, 0.567] | lower > 0 | yes |
| Raw p | 0.0312 | — | — |
| **Holm-adjusted p** | **0.0624** | **< 0.05** | **no** |

The pre-action gate eliminated repeated failure outright — relative risk
reduction 1.00 with a degenerate [1, 1] interval, meaning every trapped baseline
task was rescued in every bootstrap draw.

Timing failed on one thing: the Holm correction. The family is
{timing, content}; content's p is 0.8413, so timing's adjusted p is
2 × 0.0312 = 0.0624, just over the 0.05 bar. **Carrying a hypothesis that cannot
be supported doubled the multiplicity penalty on the hypothesis that works.**

### H6-content — rejected, but the cause is instrumentation, not capability

| Quantity | Value |
| --- | ---: |
| Repeated-failure benefit | −0.0778 (wrong direction) |
| 95% interval | [−0.222, 0.056] |
| Raw p | 0.8413 |
| Task-pass benefit | 0, interval [0, 0], p = 1 |

**Correction — this supersedes earlier revisions of this section.** Those said
the model "passed nothing at all" and concluded the task-pass metric was dead at
this model's capability. The first half is true as recorded and the second half
is wrong. The metric is dead because of a token cap.

Cross-tabulating the recorded `finalState` against `taskPassed`:

| Population | finalState | checkResult | taskPassed | rows |
| --- | --- | --- | --- | ---: |
| primary | **FIXED** | PASS | **false** | **340** |
| primary | TRAPPED | FAIL | false | 142 |
| primary | UNFIXED | FAIL | false | 418 |
| no-trap | NO_TRAP | PASS | false | 343 |
| no-trap | NO_TRAP | PASS | **true** | **17** |

**The model repaired 340 of 900 trap-bearing episodes — 37.8 percent — and every
one was recorded as `taskPassed: false`.** All 340 carry a `TOKEN_CAP` fault, and
`baseEvidence` forces `taskPassed` false whenever a cap is exceeded. That matches
the preregistration exactly: a row passes "only when the fixed offline check
returns `PASS` **within all caps**".

Token usage against the frozen `maxTotalTokens` of 16,384:

| Statistic | Tokens |
| --- | ---: |
| Minimum | 15,762 |
| Median | **17,578** |
| p90 | 19,811 |
| Maximum | 25,424 |
| **Rows at or over cap** | **1,243 of 1,260 (98.7%)** |

The median episode overruns the cap by about 1,200 tokens. The only 17 rows
recorded as passing are exactly those that finished under it, at a maximum of
16,281 tokens. `taskPassed` is therefore not measuring "solved the task" in this
run — it is measuring "finished under 16,384 tokens".

The cap traces back to an operational choice: the profile pins the context window
to 16,384 because at 32,768 this model spills to CPU and per-call latency rises
from roughly 0.75 s to 15 s. `DEFAULT_CAPS.maxTotalTokens` matches that window.
A GPU-memory decision silently disabled one of the two content metrics.

### No-trap equivalence — not equivalent

| Quantity | Value | Margin | Inside |
| --- | ---: | --- | --- |
| Pass-rate difference | 0.0167, 90% CI [0.0056, **0.0333**] | ±0.02 | **no** |
| Steps difference | -0.0056, 90% CI [-0.0222, 0.0111] | ±2 | yes |

`equivalent: false`. Steps sit far inside their margin; the pass-rate interval
does not, because its upper bound exceeds 0.02.

Note the direction: the gate slightly *raises* the pass rate on no-trap
revisions rather than making the agent timid. Equivalence testing is two-sided,
so a benefit beyond the margin fails the check exactly as a harm would. Nothing
here suggests the gate causes harm.

#### The v8 population is far healthier, and the check still fails

The v3 pilot's equivalence check had an effective sample size of two: ten of its
twelve tasks passed nothing in either arm, so all variance came from two tasks.
Amendment 2's cap correction changed that decisively.

| Measure | v3 pilot | **v8 pilot** |
| --- | ---: | ---: |
| `NO_MEMORY` no-trap pass rate | 7/180 = 0.0389 | **53/175 = 0.3029** |
| `PRE_ACTION_FAILURE` no-trap pass rate | 10/180 = 0.0556 | **56/180 = 0.3111** |
| Tasks the model can ever pass | 2 of 12 | **8 of 12** |
| Tasks with a nonzero arm difference | 2 | **4** |
| SD of per-task differences | 0.0414 | **0.0332** |
| Task-level SE | 0.0120 | **0.0096** |

Every input improved. The check still fails, and the reason is no longer a
degenerate sample — it is that the measured difference is small but not zero.

#### The registered margin is not reachable by adding tasks

The v3 revision of this section projected that ±0.02 becomes properly powered at
about 41 no-trap tasks. That projection assumed a **true difference of exactly
zero**, where the margin only has to cover sampling noise. The v8 pilot measures
a mean per-task difference of 0.0139 — 70 percent of the margin itself — with a
90% CI of [-0.0019, 0.0297] that can neither exclude zero nor confirm it.

Power depends critically on which assumption holds, and the pilot cannot settle
it. Bootstrapping the harness's own procedure from the v8 no-trap population
(resample tasks with replacement, then episodes within task, 1500–2000 trials)
gives:

| No-trap tasks | 15 ep/arm | 30 ep/arm | 45 ep/arm | 60 ep/arm |
| ---: | ---: | ---: | ---: | ---: |
| 12 (this design) | 0.002 | 0.004 | 0.007 | 0.017 |
| 18 (main split) | 0.000 | 0.003 | 0.007 | 0.012 |
| 30 | 0.000 | 0.003 | 0.009 | 0.029 |
| 60 | 0.001 | 0.022 | 0.093 | 0.142 |
| 100 | — | — | — | 0.213 |
| 180 | — | — | — | 0.306 |
| 300 | — | — | — | 0.362 |
| 500 | — | — | — | **0.591** |

**At the registered margin, five hundred tasks at sixty episodes per arm still
returns 0.591.** The decision rule's registered remedy —
`power.increaseIndependentTasksIfBelowThreshold` — cannot deliver this gate,
because the bootstrap centres on the observed nonzero difference rather than on
zero. Adding tasks shrinks the interval around 0.0139; it does not move 0.0139
far enough below 0.02 to fit a 90% interval underneath.

Holding the design at 30 tasks and varying the margin instead:

| Margin | Power at 30 tasks × 60 ep |
| ---: | ---: |
| 0.02 (registered) | 0.003 |
| 0.03 | 0.295 |
| 0.04 | 0.593 |
| **0.05** | **0.831** |
| 0.06 | 0.935 |

The check becomes answerable at a margin near 0.05 — two and a half times the
registered value.

#### Why the margin is below the design's resolution

A single episode flip moves one task's difference by 1/15 = 0.0667, more than
three times the margin it is tested against. The statistic is quantised far
coarser than its own threshold. That is a property of the design fixed before
any data existed, not a consequence of the observed results, and it is the same
class of defect as the H6-content impossibility that Amendment 3 recorded.

This supersedes the v3 recommendation that 41 tasks would settle the question.
Forty-one tasks would settle it only if the true difference were exactly zero,
which the v8 data does not support.

## What changed against the v1 pilot

| Test | v1 power | v3 power |
| --- | ---: | ---: |
| timing | 0.588 | **0.8363** |
| content | 0.000 | 0.000 |
| no-trap equivalence | 1.000 | **0.1627** |

Widening the pilot split from 6 to 12 tasks bought the timing power it was meant
to buy. The equivalence result moved the other way, which needs explaining
rather than waving away: more tasks give *narrower* intervals, and narrower
intervals make strict containment easier, not harder. So the v3 drop is not a
sample-size effect.

The likely cause is the point estimate. Equivalence is decided by where the
interval sits, not only by its width, and the v3 pass-rate difference is
+0.0167 — 83 percent of the way to the margin. An interval centred that close to
the boundary fails containment however tight it is, until the half-width falls
under about 0.0033. Whether v1's estimate sat nearer zero cannot be checked from
this run's artifacts, so the comparison is left open rather than resolved here.

## Where this leaves the study

1. **Timing is real and adequately powered.** RRR 1.00, benefit 0.317, interval
   clear of zero, and 0.8363 simulated power. It fails today only on a
   multiplicity correction imposed by a hypothesis that could not be supported.
2. **Content and equivalence were both disabled by one config value.** 98.7
   percent of rows exceeded the 16,384-token cap, which forces `taskPassed`
   false regardless of outcome. The model actually repaired 37.8 percent of
   trap-bearing episodes. The task-pass metric never measured capability in this
   run; it measured whether an episode fitted in the budget.
3. **A cap change helps but does not suffice.** Raising `maxTotalTokens` does
   restore task-pass signal, and 20,480 is the one tested value that also keeps
   both trap-audit gates. It does not deliver content power. This point
   originally recommended 24,576 as sufficient; that was a pre-test hypothesis,
   and the measured curve below disproves it — 24,576 fails the audit outright.

This supersedes the two earlier recommendations in this document. Retiring the
pass-rate equivalence check was wrong, and so was rebuilding the dataset around
"passable" tasks: the tasks were already passable 37.8 percent of the time. Both
diagnoses mistook an instrumentation limit for a property of the model or the
task set.

**The cost is lower than an earlier revision of this section claimed.** That
revision said a larger token budget needs a context window above 16,384, with
either a latency penalty or a bigger GPU. That is wrong. `maxTotalTokens` is a
**cumulative** budget summed across turns, and because each turn re-sends the
conversation, re-sent prompt tokens are counted again every turn. The context
window is a separate, per-call limit and is nowhere near exhausted.

Measured across all 1,260 episodes:

| Quantity | Value | Limit | Utilisation |
| --- | ---: | ---: | ---: |
| Peak single-call input (median) | 3,500 | 16,384 window | **21%** |
| Peak single-call input (max) | 4,396 | 16,384 window | 27% |
| Turns used | 4 to 6 | `maxTurns` 12 | never reached |
| Cumulative tokens (max) | **16,383** | `maxTotalTokens` 16,384 | **100%** |

A worked example, one episode's six turns. Prompt inputs were 1,098 → 2,278 →
2,854 → 2,954 → 3,302 → 3,424, summing to 15,910; adding that episode's 249
output tokens gives the 16,159 cumulative the cap actually counts. The largest
single context is 3,424 tokens — the sum is what hits the ceiling, not any one
call.

So the two caps contradict each other. `maxTurns` allows 12 turns, but
`maxTotalTokens` exhausts at 4 to 6, and a maximum observed cumulative of exactly
16,383 against a 16,384 cap shows episodes terminating on the ceiling rather than
on task completion.

### Raising the cap was tested, and it fails a different gate

An earlier revision called this "one constant" away from fixed. It is not. Three
trap audits, 30 tasks each, one per cap value:

| `maxTotalTokens` | trapped (gate ≥0.30) | non-fixed (gate ≥0.50) | `taskPassed` | audit |
| ---: | ---: | ---: | ---: | --- |
| 16,384 | 0.367 ✅ | 0.633 ✅ | **0/30** | PASS |
| **20,480** | **0.467 ✅** | **0.567 ✅** | **1/30** | **PASS** |
| 24,576 | 0.367 ✅ | 0.467 ❌ | 6/30 | FAIL |
| 49,152 | **0.133** ❌ | 0.167 ❌ | 12/30 | FAIL |

Raising the budget does restore the task-pass metric exactly as predicted — 0 of
30 up to 12 of 30. But the audit gate requires at least half the tasks to remain
**non-fixed**, and a model given room to finish fixes them. At 24,576 the audit
misses by a single task: 14 non-fixed where 15 are needed.

**20,480 is the one tested value that clears both gates while producing any
task-pass signal.** Trapped 14/30, non-fixed 17/30, zero invalid — both with
margin rather than on a knife edge.

That is progress on the *audit* blocker and probably not on the *content power*
blocker. One passing episode in thirty will not produce a task-pass benefit whose
95 percent interval clears zero, and 29 of 30 rows still carry `TOKEN_CAP`.

The audit-passing window and the content-measurable window appear adjacent
rather than overlapping. The trend across the four caps is inverse but not at a
constant rate, and four points do not support a stated exchange rate:

| Step | Δ passed | Δ non-fixed tasks |
| --- | ---: | ---: |
| 16,384 → 20,480 | +1 | −2 |
| 20,480 → 24,576 | +5 | −3 |
| 24,576 → 49,152 | +6 | −9 |

**The structural tension stands, narrowed but not dissolved.** The trap audit
exists to prove the benchmark is hard — at least 30 percent trapped, at least 50
percent unfixed. H6-content needs the opposite: enough completions for a
task-pass contrast. Across the whole tested range they trade against each other.

The committed cap therefore stays at 16,384 and the amendment proposing 49,152
was **not adopted**. A 20,480 amendment would now be evidence-backed, but it buys
an audit pass, not a content measurement. What remains true from the diagnosis:
`taskPassed` in the v3 pilot measured budget fit rather than capability, and the
340 repaired-but-unpassed episodes are real.

The drafted amendment (`amendment-01-draft.md`) is now moot in both halves and
should not be applied. Its content argument assumed the task-pass metric was
structurally dead; it was not. Removing content from the Holm family would still
flip timing from adjusted p 0.0624 to raw 0.0312, which is exactly why that
change should not be made on the strength of a measurement artifact.

## Design input for a next dataset version

Outcomes are not spread evenly across trap classes. Pilot totals for the 12
pilot tasks, two per class:

| Trap class | trapped rows | no-trap passes |
| --- | ---: | ---: |
| `stale-cache-illusion` | 27 | **17** |
| `flaky-looking-test` | 34 | 0 |
| `misleading-error-message` | 32 | 0 |
| `wrong-layer-fix` | 25 | 0 |
| `hidden-invariant` | 24 | 0 |
| `config-shadowing` | **0** | **0** |

Two findings follow, both measured rather than inferred.

**`config-shadowing` produced no signal of its own.** No trapped rows and no
passes in the pilot, and the full 30-task audit puts all five of its tasks at
`UNFIXED` with zero `TRAPPED` and zero `FIXED`.

**But "contributes nothing, so drop it" is wrong for the equivalence estimator,
and an earlier revision said exactly that.** The two estimators treat a
zero-outcome task differently. Timing needs a trapped baseline to form a
contrast, so a class that never traps adds no information there. Equivalence
averages a per-task *difference*, and a task scoring 0.0000 is a real
observation that pulls the mean toward zero and shrinks the spread. Removing
such tasks makes equivalence harder, not easier:

| Population | k | mean | SD | SE | 90% upper |
| --- | ---: | ---: | ---: | ---: | ---: |
| all 12 pilot tasks | 12 | 0.0167 | 0.0414 | 0.0120 | 0.0363 |
| drop the 2 `config-shadowing` | 10 | 0.0200 | 0.0450 | 0.0142 | 0.0434 |
| drop all 10 zero-difference tasks | 2 | 0.1000 | 0.0471 | 0.0333 | 0.1548 |

Every removal moves the upper bound further from the ±0.02 margin. So the
correct reading is class-specific: `config-shadowing` is dead weight **for the
timing contrast**, while for the equivalence check it is doing useful work by
supplying low-variance zeros. Any reweighting has to state which estimator it is
optimising, because the two pull in opposite directions.

**Every task pass came from `stale-cache-illusion`** — 17 of 17. If a future
version needs pass-rate signal for content or for the equivalence estimator,
that is the only class demonstrated to supply it. The tradeoff is scope: a
dataset weighted toward one trap class narrows what the study can claim, and
that is a design decision rather than a tuning knob.

### Resolved: the audit did predict the pilot; I compared the wrong fields

An earlier revision flagged an unexplained gap — the audit recording 11 of 30
tasks `FIXED` while the pilot's trap-bearing population recorded zero passes —
and said to resolve it before designing a v4. It is resolved, and it was never a
discrepancy. I was comparing the audit's `finalState` against the pilot's
`taskPassed`, which are different fields.

Compared like for like, the two agree closely:

| Source | FIXED rate |
| --- | ---: |
| Audit (30 tasks, 1 episode each) | 11/30 = **36.7%** |
| Pilot primary (900 episodes) | 340/900 = **37.8%** |

And `taskPassed` agrees too, for the same reason everywhere: **all 30 audit rows
carry a `TOKEN_CAP` fault**, so every one of the 11 `FIXED` audit rows also
records `taskPassed: false`. The cap is hit in 100 percent of audit rows and
98.7 percent of pilot rows.

So the audit is a sound cheap predictor of `finalState`, and no property of the
dataset needs re-deriving before a next version. The single thing that needs
changing is the token budget.

## Artifacts

| Item | Path |
| --- | --- |
| Run directory | `~/.remnic/bench/results/h6-pilot-v5` |
| Power | `<run>/power.json` |
| Statistics | `<run>/statistics.json` |
| Episodes | `<run>/episodes.jsonl` |
| Trap audit receipt | `<run>/trap-audit-c1d234a7….json` |
| Operational state | `docs/research/failure-gate/RESUME-HANDOFF.md` |
