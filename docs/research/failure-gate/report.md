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

### H6-content — rejected, and unsatisfiable by construction

| Quantity | Value |
| --- | ---: |
| Repeated-failure benefit | −0.0778 (wrong direction) |
| 95% interval | [−0.222, 0.056] |
| Raw p | 0.8413 |
| Task-pass benefit | 0, interval [0, 0], p = 1 |

Content requires strictly positive lower bounds on **both** metrics, and the
task-pass leg is dead for a blunter reason than an arm-level tie.

**In the trap-bearing population the model passed nothing at all: 0 of 900
episodes, across all 12 tasks and all 5 arms.** Every pass recorded anywhere in
this pilot came from `no-trap` control revisions, and even there from only two
tasks. Arm-level rates (the 0.041 figures below) are therefore carried entirely
by no-trap rows, not by the tasks the primaries are computed on.

| Arm | n | task pass | repeated failure |
| --- | ---: | ---: | ---: |
| `NO_MEMORY` | 270 | 0.041 | 0.163 |
| `PRE_ACTION_FAILURE` | 270 | 0.041 | 0.000 |
| `TURN_START_FAILURE` | 135 | 0.000 | 0.289 |
| `TURN_START_SUCCESS` | 135 | 0.000 | 0.378 |
| `BOTH` | 135 | 0.000 | 0.000 |

So the task-pass benefit is a degenerate `[0, 0]` interval with p = 1, and the
v1 pilot measured content power 0.000 independently. The binding constraint is
not that the two content arms tie — it is that this model never repairs a
trapped task, so the metric has no signal to measure. That is a statement about
the present operating point rather than a proof about all data: it would lift
with a model that can sometimes fix these tasks. Nothing in the evidence
suggests the current one can.
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
   multiplicity correction imposed by a hypothesis that cannot be supported.
2. **Content cannot be rescued by more tasks of the current kind.** The model
   passes none of the trap-bearing tasks — 0 of 900 episodes — so the task-pass
   leg has no signal. What would rescue it is a task set this model can
   sometimes solve, not a larger one.
3. **Equivalence is under-resourced, not unusable.** The registered ±0.02 margin
   becomes properly powered at roughly 41 no-trap tasks. Ten of the current 12
   contribute exactly zero, so the effective sample size is 2. The fix is more
   *passable* tasks, and it needs no change to any threshold.

Points 2 and 3 share one cause: at this model's capability almost every task is
unsolvable, which starves both the content metric and the equivalence estimator.
A dataset built around tasks the model can sometimes pass would address both
without weakening the protocol — and that is exactly the "new dataset version"
the objective called for, aimed at pass-rate signal rather than trap coverage.

The drafted amendment (`amendment-01-draft.md`) removes content from the main
power gate. Its content argument still holds; its no-trap sections are
superseded by the corrected estimator above and should not be applied as
written.

Any amendment that drops content also removes it from the Holm family, which
moves timing from adjusted p 0.0624 to raw 0.0312 and flips it to `SUPPORTED`.
That is a large, self-serving-looking consequence of a post-hoc change and must
be argued on the pre-existing structural grounds — content was unsatisfiable
before this run, and was measured so in v1 — not on the fact that removing it
helps timing.

## Artifacts

| Item | Path |
| --- | --- |
| Run directory | `~/.remnic/bench/results/h6-pilot-v5` |
| Power | `<run>/power.json` |
| Statistics | `<run>/statistics.json` |
| Episodes | `<run>/episodes.jsonl` |
| Trap audit receipt | `<run>/trap-audit-c1d234a7….json` |
| Operational state | `docs/research/failure-gate/RESUME-HANDOFF.md` |
