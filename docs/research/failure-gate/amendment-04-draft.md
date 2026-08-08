# Amendment 4 (DRAFT — awaiting approval): the no-trap pass-rate margin

Status: **draft. Not applied. The study remains blocked pending a decision.**

## What is proposed

One of two options, to be chosen by the study owner. Both leave the no-trap
equivalence check registered, estimated, and reported. Neither touches any other
threshold, hypothesis, margin, task, or arm.

**Option A — widen the pass-rate margin from 0.02 to 0.05.**
The check keeps gating the main run. It becomes answerable by the existing
design (power 0.831 at 30 tasks × 60 episodes per arm).

**Option B — remove the pass-rate half of the check from the main-run gate.**
The steps half continues to gate, unchanged at ±2. The pass-rate difference is
still estimated and reported under its unchanged 0.02 rule; it simply stops
blocking execution. This mirrors exactly what Amendment 3 did for H6-content.

## Why an amendment is needed

The v8 pilot completed 1260/1260 rows with zero invalid rows and zero host
faults. Timing power reached 0.9499 against a 0.80 bar. Under Amendment 3 the
main-run gate is timing plus no-trap equivalence, so equivalence is the only
remaining blocker, at 0.1311.

The decision rule already registers a remedy for low power:
`power.increaseIndependentTasksIfBelowThreshold`. **That remedy cannot deliver
this gate.** Bootstrapping the harness's own procedure from the v8 no-trap
population:

| No-trap tasks (60 ep/arm) | 60 | 100 | 180 | 300 | 500 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Power at margin 0.02 | 0.142 | 0.213 | 0.306 | 0.362 | **0.591** |

Five hundred tasks — a sixteen-fold expansion — still returns 0.591. The
bootstrap centres on the measured per-task difference of 0.0139, which is 70
percent of the margin itself, so shrinking the interval never moves the estimate
far enough under the threshold to fit a 90 percent interval beneath it.

## Why this is a pre-existing design defect, not a result-driven change

The margin is below the design's measurement resolution, and this was fixed
before any data existed. Each task contributes 15 no-trap episodes per arm, so a
single episode flip moves that task's difference by 1/15 = 0.0667 — more than
three times the 0.02 margin. The statistic is quantised coarser than the
threshold it is tested against.

The steps half of the same check has roughly 60× headroom against its ±2 margin.
The two margins were never set from common operating characteristics.

This is the same class of defect as the H6-content impossibility recorded in
Amendment 3: a registered condition that no achievable configuration satisfies.

## The v8 data is not a degenerate sample

The v3 pilot's equivalence check had an effective sample size of two. That is no
longer the objection — every input improved and the check still fails:

| Measure | v3 pilot | v8 pilot |
| --- | ---: | ---: |
| `NO_MEMORY` no-trap pass rate | 7/180 = 0.0389 | 53/175 = 0.3029 |
| `PRE_ACTION_FAILURE` no-trap pass rate | 10/180 = 0.0556 | 56/180 = 0.3111 |
| Tasks the model can ever pass | 2 of 12 | 8 of 12 |
| Tasks with a nonzero arm difference | 2 | 4 |
| SD of per-task differences | 0.0414 | 0.0332 |
| Task-level SE | 0.0120 | 0.0096 |

## Consequences, recorded before the decision

These are stated explicitly so they cannot be mistaken later, following the
precedent Amendment 3 set.

1. **Both options unblock a study that is currently blocked.** That is their
   purpose and also their risk. The justification must rest on the
   pre-existing resolution defect above, never on the fact that unblocking is
   convenient.
2. **The measured difference favours the gate.** `PRE_ACTION_FAILURE` passes
   slightly *more* no-trap revisions than `NO_MEMORY` (+0.0139 per task, 90% CI
   [-0.0019, 0.0297]). Equivalence is two-sided, so this fails containment
   exactly as a harm would. Nothing in the data suggests the gate causes harm.
3. **Option A weakens a claim.** A ±0.05 margin is a materially weaker statement
   than ±0.02, and the report must state the widened margin wherever the
   equivalence result is quoted.
4. **Option B narrows the gate.** The pass-rate question goes unanswered by this
   study rather than answered loosely. It must be recorded as unresolved, not as
   passed.
5. **No other threshold moves** under either option: the 0.80 power bar, the
   0.05 alpha, the timing support conditions, the zero-cut rule, the ±2 steps
   margin, and every other registered margin stand unchanged.

## Recommendation

**Option B.** It is the more conservative of the two: it declines to answer a
question the design cannot resolve, rather than answering it at a margin chosen
after seeing the data. Option A's 0.05 was selected by reading a sensitivity
table computed from the observed results, which is precisely the inference path
Amendment 3 warned against. Option B leaves the pass-rate rule untouched at
0.02, keeps reporting it, and marks it unresolved.

## Evidence

| Item | Location |
| --- | --- |
| v8 pilot power artifact | `~/.remnic/bench/results/h6-pilot-v8/power.json` |
| v8 statistics | `~/.remnic/bench/results/h6-pilot-v8/statistics.json` |
| 32k profile audit receipt | `packages/bench/fixtures/h6-failure-gate/trap-audit.json` |
| Power projections and margin sensitivity | `docs/research/failure-gate/report.md` |
