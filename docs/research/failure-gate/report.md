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

Content requires strictly positive lower bounds on **both** metrics. The
task-pass benefit is exactly zero because both content arms pass zero tasks:

| Arm | n | task pass | repeated failure |
| --- | ---: | ---: | ---: |
| `NO_MEMORY` | 270 | 0.041 | 0.163 |
| `PRE_ACTION_FAILURE` | 270 | 0.041 | 0.000 |
| `TURN_START_FAILURE` | 135 | 0.000 | 0.289 |
| `TURN_START_SUCCESS` | 135 | 0.000 | 0.378 |
| `BOTH` | 135 | 0.000 | 0.000 |

Both content arms passed zero of 135 episodes here, and the v1 pilot measured
content power 0.000 independently. On that evidence the task-pass benefit is a
degenerate `[0, 0]` interval with p = 1, and no realistic increase in sample
size makes it produce a positive lower bound while the underlying rate stays at
the floor. This is a statement about the observed operating point, not a proof
about all possible data: the constraint would lift if the model's task-pass rate
rose materially above zero in these arms. At this model's capability, where even
the best arm fully repairs 4.1 percent of tasks, that is not in prospect.

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

#### The ±0.02 margin is below this design's noise floor

The equivalence check had almost no room to pass. Measured
no-trap population, 12 tasks × 15 episodes per arm:

| Arm | n | passes | pass rate | mean steps |
| --- | ---: | ---: | ---: | ---: |
| `NO_MEMORY` | 180 | 7 | 0.0389 | 5.328 |
| `PRE_ACTION_FAILURE` | 180 | 10 | 0.0556 | 5.361 |

The entire non-equivalence verdict rests on **three episodes** — 7 passes versus
10 out of 180 — in the direction that favours the gate.

| Quantity | Value |
| --- | ---: |
| Registered margin | 0.0200 (≈ 3.6 episodes of 180) |
| SE of the pass-rate difference | 0.0224 |
| 90% CI half-width (1.645·SE) | 0.0368 |
| **margin ÷ SE** | **0.89** |

A 90% interval fits strictly inside a margin only when that margin exceeds about
1.645 standard errors of the statistic. Here the margin is **0.89 SE** — smaller
than one standard error of the quantity it constrains. Under the normal
approximation, even a true difference of exactly zero yields a half-width of
0.0368, roughly 1.8× too wide to fit, and reaching strict containment under an
exact null needs about 609 episodes per arm, or **41 no-trap tasks** against the
12 this design has.

To be precise about what that does and does not establish: the check was not
strictly impossible. The realised interval is a task-level bootstrap, not the
normal approximation, and had the two arms produced identical pass counts the
resulting interval could have landed just inside ±0.02. What the arithmetic
shows is that passing required the observed difference to sit essentially on
zero — a knife-edge, not a robust test. A three-episode difference out of 180,
which is roughly one step of the metric's resolution, was enough to fail it.

Two things follow. First, the equivalence failure is far more a property of the
specification than a finding about the gate. Second, the two margins were set
with wildly inconsistent stringency: the pass-rate margin sits below the noise
floor while the steps margin (±2 against an observed 0.0333) has roughly **60×**
headroom. Margins derived from the design's own operating characteristics — a
3.9 percent base rate and 180 episodes per arm — would not look like that.

This is a specification defect that was detectable before the run, from the base
rate and episode count alone, without reference to any observed difference. That
distinction matters: correcting the margin on those grounds is a principled
re-derivation, whereas widening it because the test failed would be threshold
shopping. Any correction must be argued and documented on the pre-run arithmetic.

#### No margin works at this operating point

Loosening the margin is not a fix either. For an equivalence test to reach 80
percent power *at a true difference of zero*, the margin must exceed
`(z₀.₉₅ + z₀.₉) · SE ≈ 2.93 · SE`. Applying that to this design:

| No-trap tasks | episodes/arm | SE | margin needed for 80% power |
| ---: | ---: | ---: | ---: |
| **12 (this design)** | 180 | 0.0224 | **0.0654** |
| 18 | 270 | 0.0183 | 0.0534 |
| 41 | 615 | 0.0121 | 0.0354 |
| 100 | 1500 | 0.0077 | 0.0227 |
| 200 | 3000 | 0.0055 | **0.0160** ✓ |

The design is caught between two impossibilities. Keeping the registered ±0.02
margin requires roughly **200 no-trap tasks**, sixteen times the current
population. Keeping the current 12 tasks requires a margin of **0.0654**, which
is 1.4× the base pass rate itself — a band wide enough to permit the pass rate
doubling or vanishing, which asserts nothing.

The cause is that task pass is a rare event here (3.9 to 5.6 percent).
Equivalence testing on a rare binary outcome needs very large samples, and no
choice of margin substitutes for them.

**Recommendation: retire the pass-rate equivalence check from this design rather
than loosen it.** The steps half of the same check is viable and passes with 60×
headroom, so the timidity question — does the gate make the agent work harder or
behave more cautiously on tasks with no trap — is answerable, and the answer is
no. Retaining the pass-rate half at any margin this design can support would
manufacture a verdict rather than measure one. If pass-rate equivalence is
scientifically required, it needs a fundamentally larger study or a task set
where the model's base pass rate is not near the floor.

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
2. **Content cannot be rescued by more data.** Any further pilot spends compute
   to re-measure a structural zero.
3. **Equivalence needs a decision, not more tasks.** The pass-rate interval
   misses a ±0.02 margin by 0.019. Whether that margin is right for a 4.1 percent
   base pass rate is a scientific judgment; re-running without changing anything
   will reproduce it.

The drafted amendment (`amendment-01-draft.md`) removes content from the main
power gate. On this evidence it is necessary but **not sufficient** — the
no-trap gate now fails too, which the draft predates and does not address.

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
