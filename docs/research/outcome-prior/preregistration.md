# H1 outcome prior — preregistration

Status: scaffolding only. This document freezes the comparison. It does not
report a warm, pilot, or locked run.

## Controlling record

GitHub issue #1958. The build plan in
[comment 4998194342](https://github.com/joshuaswarren/remnic/issues/1958#issuecomment-4998194342)
is the authoritative clock, arm list, and pass rule. Where older issue-body
text disagrees with that comment, the comment wins.

## Hypothesis

H1: an outcome signal is a better retrieval prior than text similarity alone.
The primary metric is recall@k on held-out queries from the locked epochs.
Arms are paired by user, data seed, and run seed.

H1b uses the same locked weight plus a named task runner and its own power
plan. No task runner is wired in this change, so H1b is **NOT RUN**.

## Clock

| Stage | Epochs | Role |
| --- | --- | --- |
| Warm | 1–8 | Fit the store. Not a confirmatory comparison. |
| Pick | 9–10 | Choose one weight w* from {0.15, 0.30, 0.50}. |
| Locked test | 11–12 | Evaluate that one weight once. |

Pick-stage p-values, if all three weights are tested, use a Holm correction.
The locked test is a single comparison and is not corrected again.

## Arms

Competing recall boosts are off on every H1 arm: Memory Worth filter,
trust score, access-count boost, and reinforcement recall boost are false,
and `recencyWeight` is 0. Retrieval budget `k` and the context cap are the
same on every arm, including the Memory Worth base arm.

`w = 0` is the H1 path with the outcome blend off. It is not the live
production default. Production leaves `outcomeBoostEnabled` false, so the
outcome helper is not called.

The Memory Worth base arm is separate. It turns the Memory Worth filter on
and the outcome blend off, and it does not force the other boosts off.

## Score scale

Text scores use a fixed clamp into [0, 1]: non-finite or `<= 0` becomes 0,
`>= 1` becomes 1, and values already inside the interval stay put. This is
not a batch min-max.

Weight 0 returns the raw input score. It does not replace that score with
the clamped unit score, and it does not reorder ties.

## UNOBSERVED is not the Beta prior

Memory Worth uses a Laplace Beta(1,1) prior, `(s+1)/(s+f+2)`, whose neutral
value is 0.5. H1 does not.

- Both counters missing, explicit 0 and 0, or a present counter that is not a
  finite number `>= 0` is **UNOBSERVED**.
- UNOBSERVED keeps the clamped text score when the weight is positive. It is
  not pulled toward 0.5.
- One counter present and positive, with the other missing, is **OBSERVED**.
  The missing counter counts as 0.
- OBSERVED uses the maximum-likelihood rate `success / (success + fail)`.

Lookup uses the recall memory map key (namespace plus path), not the bare path.

## Decision rule

On the locked split, H1 is SUPPORTED only when all three hold:

- relative recall gain is at least 5% (`(candidate - baseline) / baseline`)
- the paired 95% bootstrap interval for the gain stays strictly above 0
- the paired shuffle p-value is below 0.05

The bootstrap is 10,000 draws, grouped by user. MRR, nDCG, score spread,
prior shape, and weights other than the locked w* are side results and cannot
flip the decision.

The machine-readable copy is
`packages/bench/fixtures/h1-outcome/decision-rule.json`.

The scaffold helper computes the paired interval and Cohen's d with
`packages/bench/src/stats/*`. A missing shuffle p-value is **not-estimable**.
This change does not add a second stats implementation, and it does not run
the shuffle test or the Holm correction.

## Out of scope for this change

The synthetic task family and the 2-user / 4-epoch CI snapshot are committed
under `packages/bench/fixtures/h1-outcome/`. `--gates` checks that snapshot.
Warm, pilot, and main phases still refuse. No locked run, no pilot that
freezes N, and no result JSONL. H1 SUPPORTED is not claimed.
