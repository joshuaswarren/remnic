# H6 failure gate — pilot report

Status: **v3 pilot complete (1260/1260 rows, zero invalid). Study decision:
REJECT. Timing power gate met; main run blocked by content and no-trap power.**

Run: `h6-pilot-v5`, dataset inventory `687615b5…`, 12 pilot tasks, 5 seeds,
5 arms, 3 variants. Zero task cuts.

## Power simulation — the gate on the main run

Ten thousand task-group bootstrap experiments, each resampling 18 tasks from the
12-task pilot population.

| Test | Simulated power | Required | Verdict |
| --- | ---: | ---: | --- |
| H6-timing | **0.8363** | 0.80 | **PASS** |
| H6-content | 0.0000 | 0.80 | FAIL |
| No-trap equivalence | 0.1627 | 0.80 | FAIL |

`verifyPilotPower` requires all three, so the main run remains blocked.

**The registered timing-power objective is met.** The current dataset carries
enough trap-effective independent tasks; no new dataset version is needed for
timing. That question is closed.

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
| Pass-rate difference | 0.0167, 90% CI [0, **0.0389**] | ±0.02 | **no** |
| Steps difference | 0.0333, 90% CI [0, 0.0722] | ±2 | yes |

`equivalent: false`. Steps are comfortably inside the margin; the pass-rate
interval is not, because its upper bound of 0.0389 exceeds the 0.02 margin.

Note the direction: the gate slightly *raises* the pass rate on no-trap
revisions rather than making the agent timid. Equivalence testing is two-sided,
so a benefit beyond the margin fails the check just as a harm would. The
registered claim "the gate does not change behavior on tasks with no trap" is
not supported at the registered margin, but nothing here suggests the gate
causes harm.

#### The check has an effective sample size of two

**Correction.** An earlier revision of this section computed the standard error
from an episode-level binomial approximation, giving SE 0.0224, margin ÷ SE
0.89, and a requirement of roughly 200 no-trap tasks. That was the wrong
estimator. The analysis bootstraps at the **task** level, so the SE must come
from the spread of per-task differences. The corrected figures are below and
they change the conclusion.

Measured no-trap population, 12 tasks × 15 episodes per arm:

| Arm | n | passes | pass rate | mean steps |
| --- | ---: | ---: | ---: | ---: |
| `NO_MEMORY` | 180 | 7 | 0.0389 | 5.328 |
| `PRE_ACTION_FAILURE` | 180 | 10 | 0.0556 | 5.361 |

Per-task differences tell the real story:

| Task | baseline | candidate | difference |
| --- | ---: | ---: | ---: |
| `h6-task-21` | 5/15 | 6/15 | +0.0667 |
| `h6-task-22` | 2/15 | 4/15 | +0.1333 |
| **other 10 tasks** | **0/15** | **0/15** | **0.0000** |

**Ten of twelve tasks contribute exactly zero** — the model passes none of them
in either arm. All variance in the statistic comes from two tasks, so the
equivalence check has an effective sample size of **2**, not 12, and the whole
verdict turns on three extra passes (one in `21`, two in `22`).

| Quantity | Value |
| --- | ---: |
| Registered margin | 0.0200 |
| SD of per-task differences | 0.0414 |
| **Task-level SE** | **0.0120** |
| 90% half-width (1.645·SE) | 0.0197 |
| **margin ÷ SE** | **1.67** |

At 1.67 SE the margin sits just above the 1.645 needed for containment to be
possible at all, so — contrary to the earlier revision — equivalence was **not**
out of reach by construction. It was reachable only if the observed difference
sat almost exactly on zero, which two passable tasks out of twelve could not
deliver.

The steps half of the same check has roughly 60× headroom (0.0333 observed
against a ±2 margin). That asymmetry is still real: the two margins were not set
from the same operating characteristics.

#### What it would take, using the correct estimator

For an equivalence test to reach 80 percent power *at a true difference of
zero*, the margin must exceed `(z₀.₉₅ + z₀.₉₀) · SE ≈ 2.93 · SE`. Holding the
observed per-task spread (SD 0.0414) and scaling the task count:

| No-trap tasks | task-level SE | margin needed for 80% power |
| ---: | ---: | ---: |
| **12 (this design)** | 0.0120 | **0.0350** |
| 18 | 0.0098 | 0.0286 |
| 30 | 0.0076 | 0.0221 |
| **41** | 0.0065 | **0.0189** ✓ |
| 60 | 0.0053 | 0.0157 ✓ |
| 100 | 0.0041 | 0.0121 ✓ |

**The registered ±0.02 margin becomes properly powered at about 41 no-trap
tasks** — roughly 3.4× the current population, not the sixteen-fold increase the
earlier revision claimed. That is a larger study, but an ordinary one.

This supersedes the previous recommendation to retire the pass-rate check. The
check is not unusable; it is under-resourced. Retiring a test that a 41-task
design would answer cleanly would discard a real question rather than settle it.

The caveat is that the SD is itself estimated from two informative tasks, so the
41 figure is indicative rather than precise, and it assumes added tasks resemble
the existing mix. Given that 10 of 12 current tasks contribute nothing, the more
efficient route is not simply more tasks but more tasks the model can sometimes
pass: the effective sample size, not the nominal one, is what sets the SE.

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
3. **The remedy is a cap, not a redesign.** Raising `maxTotalTokens` past the
   observed p90 of ~19,800 — with headroom, say 24,576 — should restore
   task-pass signal to both content and the equivalence estimator without
   touching a single decision threshold, task, or hypothesis.

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

A worked example, one episode's six turns: inputs of 1,098 → 2,278 → 2,854 →
2,954 → 3,302 → 3,424, cumulating to 16,159. The largest single context is 3,424
tokens; the sum is what hits the ceiling.

So the two caps contradict each other. `maxTurns` allows 12 turns, but
`maxTotalTokens` exhausts at 4 to 6, and a maximum observed cumulative of exactly
16,383 against a 16,384 cap shows episodes terminating on the ceiling rather than
on task completion. Allowing the registered 12 turns needs roughly 45,000
cumulative tokens, so a cap near 49,152 would make the turn budget binding as
designed.

**The remedy is one constant.** No context-window change, no latency tradeoff, no
different GPU — peak per-call usage would still sit far inside 16,384 even at 12
turns. Then re-audit and re-pilot.

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
