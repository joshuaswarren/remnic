# Amendment 1 (DRAFT — not yet applied, and now INCOMPLETE)

Status: drafted before the v3 pilot finished, then overtaken by its results.
**Dropping content is necessary but no longer sufficient.** The completed pilot
shows the no-trap equivalence gate also fails, which this draft predates and
does not address. Do not apply as written; see "Second blocker" below.

Applying any version of this invalidates the completed pilot, its audit receipt,
and the harness hash. Sequencing lives in `RESUME-HANDOFF.md`; measured results
live in `report.md`.

## Second blocker: no-trap equivalence (measured, added after the pilot)

| Test | Simulated power | Required |
| --- | ---: | ---: |
| H6-timing | 0.8363 | 0.80 |
| H6-content | 0.0000 | 0.80 |
| No-trap equivalence | **0.1627** | 0.80 |

`equivalent: false`. The pass-rate difference is +0.0167 with a 90% interval of
[0, 0.0389] against a ±0.02 margin — the point estimate sits inside the margin
but the interval does not, so strict containment fails. Steps are comfortably
inside (0.0333, interval [0, 0.0722], margin 2).

More tasks do not obviously fix this. Resampling the pilot's 12 task groups to
larger simulated experiments holds equivalence power far below the bar while
timing saturates:

| Simulated tasks | equivalence | timing |
| ---: | ---: | ---: |
| 18 | 0.137 | 0.813 |
| 30 | 0.173 | 0.993 |
| 50 | 0.150 | 1.000 |
| 80 | 0.223 | 1.000 |
| 120 | 0.233 | 1.000 |

**Read that table with care.** It resamples 12 real task groups, so beyond a
point it duplicates rather than adds information, and it cannot tell you what
120 genuinely independent tasks would do. What it does establish is that the
harness's own power procedure — the one that produced the official 0.1627 —
keeps equivalence far below 0.80 at every experiment size, while timing is
robust from 18 tasks upward.

The mechanism is arithmetic. The margin is 0.89 standard errors of the statistic
it constrains; strict containment of a 90 percent interval needs roughly 1.645.
Even a true difference of exactly zero produces an interval about 1.8× too wide.

### No margin works at this operating point

Loosening is not a fix either. Reaching 80 percent equivalence power at a true
difference of zero needs a margin above `(z₀.₉₅ + z₀.₉) · SE ≈ 2.93 · SE`:

| No-trap tasks | episodes/arm | SE | margin needed |
| ---: | ---: | ---: | ---: |
| **12 (this design)** | 180 | 0.0224 | **0.0654** |
| 41 | 615 | 0.0121 | 0.0354 |
| 100 | 1500 | 0.0077 | 0.0227 |
| 200 | 3000 | 0.0055 | **0.0160** ✓ |

Keeping ±0.02 needs about **200 no-trap tasks**, sixteen times the current
population. Keeping 12 tasks needs a margin of **0.0654**, which is 1.4× the base
pass rate — a band permitting the pass rate to double or vanish, which asserts
nothing. Task pass is a rare event here (3.9–5.6 percent), and equivalence
testing on a rare binary outcome needs very large samples that no margin choice
substitutes for.

## Recommended resolution for the second blocker

**Retire the pass-rate half of the no-trap check from this design rather than
loosen it.** The steps half is viable and passes with 60× headroom, so the
timidity question — does the gate make the agent work harder or behave more
cautiously where there is no trap — is answerable, and the answer is no.
Retaining the pass-rate half at any margin this design supports would
manufacture a verdict instead of measuring one.

Rejected alternatives, recorded so the reasoning survives:

- **Widen the margin to 0.0654.** Meaningless at a 3.9 percent base rate.
- **Drop the whole no-trap check from the gate.** Discards the steps result,
  which is both valid and informative.
- **Grow to 200 no-trap tasks.** Scientifically clean, but a fundamentally
  larger study; worth doing only if pass-rate equivalence is itself a
  deliverable.
- **Do not run main at all.** Still viable. The pilot already answers the
  science: timing real (RRR 1.00, benefit 0.317, interval [0.100, 0.567]),
  content dead, steps-equivalence supported.

---

# Original draft (content gate only)
## What changes

H6-content stops gating the main run. It remains a registered hypothesis, is
reported in every table, and is recorded as `REJECTED` on its own evidence. The
main-run power gate becomes timing and the no-trap equivalence check only.

## Why

H6-content requires benefit on two metrics: repeated failure and task pass. The
task-pass leg is not underpowered — it is identically zero, so no sample size
can satisfy it.

Measured arm rates from the v3 pilot population (uncut tasks, 945 primary rows):

| Arm | n | task pass | repeated failure |
| --- | ---: | ---: | ---: |
| `NO_MEMORY` | 270 | 0.041 | 0.163 |
| `PRE_ACTION_FAILURE` | 270 | 0.041 | 0.000 |
| `TURN_START_FAILURE` | 135 | 0.000 | 0.289 |
| `TURN_START_SUCCESS` | 135 | 0.000 | 0.378 |
| `BOTH` | 135 | 0.000 | 0.000 |

Both content arms — `TURN_START_FAILURE` and `TURN_START_SUCCESS` — pass zero
tasks. The task-pass benefit is therefore exactly 0 with a degenerate `[0, 0]`
95% interval and p = 1, so
`requireTaskPassBenefitIntervalLowerStrictlyAbove: 0` can never hold. Simulated
content power is exactly 0.000, and the v1 pilot independently measured content
power 0.000 under the same rule.

The root cause is model capability, not experimental design: the registered
model fully repairs at most 4.1 percent of tasks in any arm, so the task-pass
metric carries almost no signal at this scale. Content's repeated-failure leg
does show a real effect (+0.089, 95% CI [0.022, 0.178]), which is why the
hypothesis is reported rather than deleted.

The existing preregistration already anticipates under-power by requiring more
independent tasks in a new dataset version. That remedy is inapplicable here:
adding tasks cannot move a metric that is identically zero in both arms. This
amendment records that distinction instead of repeatedly re-running a pilot that
cannot change the outcome.

## Text edits

Both copies of the preregistration must be edited identically:
`docs/research/failure-gate/preregistration.md` and
`packages/bench/preregistration/h6-failure-gate.md`.

### 1. "Power and the no-trap check", first paragraph

Replace:

> Timing and content each need at least 0.80 simulated power under their
> registered support rules.

With:

> Timing needs at least 0.80 simulated power under its registered support rule.
> Content is excluded from the main-run power gate by Amendment 1; it is still
> estimated, reported, and decided under its registered support rule, but a
> content power below 0.80 no longer blocks main execution.

Append to the same paragraph:

> Adding independent tasks is the registered remedy only for a test that is
> genuinely underpowered. It does not apply to a support condition whose metric
> is identically zero in both compared arms; see Amendment 1.

### 2. "Decision rules", study-decision mapping

Leave the `PASS` / `PARTIAL` / `REJECT` / `NOT_ESTIMABLE` mapping unchanged. The
study decision continues to account for both primaries. Only the *power gate*
that guards main execution changes.

### 3. New section, placed after "Power and the no-trap check"

> ## Amendment 1: content is excluded from the main-run power gate
>
> Date: (fill in on apply). Applies from the pilot run that follows it.
>
> H6-content requires a strictly positive lower bound on the task-pass benefit
> interval. Two independent pilots measured a task-pass rate of exactly zero in
> both content arms, making that condition unsatisfiable at any sample size and
> fixing simulated content power at 0.000. The main-run power gate therefore
> requires timing power and no-trap equivalence power only.
>
> H6-content remains registered and reported. On the evidence above it is
> recorded as `REJECTED`, and the study decision mapping is unchanged. No
> decision threshold is altered: the 0.80 bar, the 0.05 alpha, the timing
> support conditions, the zero-cut rule, and the equivalence margins all stand.

### 4. Retiring the pass-rate half of the no-trap check (verified against source)

The recommendation is cleanly implementable — checked against the code, not
assumed. `isRepeatedFailureTimidityEquivalent`
(`repeated-failure-stats.ts:525-537`) is a flat four-condition AND:

```ts
return (
  passRateInterval.lower > -passMargin &&
  passRateInterval.upper < passMargin &&
  stepsInterval.lower > -stepsMargin &&
  stepsInterval.upper < stepsMargin
);
```

Retiring the pass-rate half means dropping its two conditions and keeping the
steps pair. Reporting is unaffected: `passRateDifference` and
`passRateInterval` are assigned independently at lines 653-654, and `passMargin`
stays in the artifact, so the pass-rate numbers remain measured, published, and
auditable — only their gating role is removed.

Keep `passMargin` in the emitted analysis even though the predicate no longer
reads it. A reader must be able to see the margin that was retired and why.

## Code and artifact edits

1. `packages/bench/src/coding-graph/repeated-failure-suite-analysis.ts`, in
   `verifyPilotPower`: drop `|| power.contentPower < 0.8` from the gate. Keep
   timing and timidity. Keep reporting content power in the artifact.
2. Both `decision-rule.json` copies: update `preregistration.sha256` to the new
   hash of the amended preregistration. Do **not** remove the `H6-content`
   hypothesis block — it is still estimated and reported.
3. **Add** a test — do not look for one to update. The power threshold gate is
   currently untested. `repeated-failure-suite.test.ts:1645` ("main phase
   rejects reduced frozen inputs and cannot start without verified pilot
   power") only covers a *missing* pilot run via `/verified pilot run/`; nothing
   exercises the `< 0.8` comparisons in
   `repeated-failure-suite-analysis.ts:666-668`. Add a case that feeds a pilot
   whose content power is 0 and whose timing and timidity powers clear 0.80, and
   assert main now starts. Add its mirror: timing below 0.80 must still throw
   `/underpowered/`. Without both, a later edit could silently restore or
   destroy the gate with no failing test.
4. `pnpm --filter @remnic/bench build`, then re-run the trap audit, then the
   pilot.

## What this amendment does not do

- It does not lower the 0.80 power threshold.
- It does not alter any H6-timing support condition.
- It does not relax the zero-cut rule or the equivalence margins.
- It does not delete H6-content or hide its result.
