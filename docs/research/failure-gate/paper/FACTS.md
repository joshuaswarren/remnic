# H6 paper fact sheet — every number traces to a registered artifact

Single source for the arXiv paper and blog post. Do not cite a number that is
not on this sheet. Artifact roots: `h6-main-v1` (first registration),
`h6-timing-v2` (confirmatory rerun), `h6-pilot-v10` (bound pilot),
`h6-timing-v1` (abandoned manifest); hash-bound, with episode logs and
finalized-run analysis artifacts published as release assets on tag
`h6-study-2026-08` (trace archives operator-local).

## Study design (frozen)

- 30 synthetic TypeScript repair tasks, dataset schema v1, inventory
  `687615b5…`; 6 trap classes x 5 tasks: config-shadowing,
  flaky-looking-test, hidden-invariant, misleading-error-message,
  stale-cache-illusion, wrong-layer-fix. Same-class similarity capped at
  0.40 normalized Jaccard on state-defining sources and check scripts.
- Splits: pilot 12 tasks, main 18 tasks, dev 0. 3 run-time variants per
  task; two-episode protocol (episode 1 creates frozen failure history,
  only episode 2 is scored).
- Model: qwen3.5:35b (open weights), Q4_K_M quantization, 32,768-token
  context, temperature 0, no thinking mode, maxOutputTokens 4096, served
  digest pinned (`3460ffee…`), profile hash `c581ecef…`.
- Caps: 12 turns, 8 tool calls, 20,480 cumulative tokens (Amendment 2),
  600 s duration, 180 s request timeout, 16,384-char tool output.
- Arms (first registration, 5): NO_MEMORY, TURN_START_FAILURE,
  TURN_START_SUCCESS, PRE_ACTION_FAILURE, BOTH; plus paired no-trap rows
  for NO_MEMORY and PRE_ACTION_FAILURE. Rerun registration: 2 arms
  (TURN_START_FAILURE, PRE_ACTION_FAILURE) only.
- Timing pair injection contract: identical fact ID, citation hash, fact
  count (1), and rendered token count; only delivery point differs. Gate
  is advisory; ERROR_FAIL_OPEN rows are invalid by rule (never occurred).
- Content pair: failure fact from the task's own trap run vs matched
  twin-repo success fact; token-set Jaccard in [0.80, 1.00], token gap
  <= 8 and <= 5%.
- Analysis: task-level unit, 10,000-draw grouped bootstrap (percentile,
  95%), 10,000-draw paired sign-flip randomization test, Holm correction,
  alpha 0.05, statistics seed 81. Timing support rule: absolute benefit
  >= 0.05, point RRR >= 0.30, CI lower bound > 0, adjusted p < 0.05.

## Registrations

- Registration 1 (decision rule v12, prereg sha `0fe2838c…`): both
  hypotheses; 1,890 expected rows; seeds 1-5; zero primary task cuts
  allowed. Amendments: 2 (cumulative token cap 16,384 -> 20,480, chosen
  by four 30-task trap audits), 3 (content removed from the power gate;
  content power measured 0.000 twice), 4 (no-trap pass-rate half removed
  from the launch gate; the 0.02 margin is unresolvable at any feasible
  task count — 0.591 power at 500 tasks x 60 episodes).
- Registration 2 (decision rule v13, prereg sha `4cf77570…`, rule sha
  `df345592…`): H6-timing only; 540 rows; NEW seeds 6-10; single-member
  Holm family; VAGUE_CHECK scored worst-case against the pre-action arm
  (repeatedFailure=true/taskPassed=false in PRE_ACTION, false/true in
  TURN_START, steps 0) instead of cutting; zero-cut rule retained for all
  other invalid reasons; pilot power transferred by pinned artifact
  hashes with mandatory byte-identical replay before launch.

## Pilot (bound, v10)

- 12 tasks x 3 variants x 5 seeds x 7 row types = 1,260 rows.
- Simulated H6-timing power at 18 tasks: 0.8364 (>= 0.80 required).
- Pilot timing point estimate: +37.78 pp (descriptive).
- Content power 0.0012. Timidity power 1.0.

## Registration 1 main run (h6-main-v1) — decision NOT_ESTIMABLE

- 1,890/1,890 rows; 1,888 valid; 2 invalid (both VAGUE_CHECK:
  h6-task-10 v3 seed 4 PRE_ACTION_FAILURE, token cap after 6 steps;
  h6-task-13 v1 seed 1 NO_MEMORY, duration cap after 2 steps); 3 host
  faults retried under the frozen rule; empty deviation log.
- 43,377,443 total tokens; 167,648,106 ms (46.57 h) summed episode time.
- Timing (EXPLORATORY_COMPLETE_TASKS, 17 tasks): benefit +38.04 pp,
  95% CI [18.04, 59.61]; RRR 1.00 [1.00, 1.00]; raw p 0.0018, Holm
  0.0036. NOT_ESTIMABLE by the zero-cut rule (h6-task-10 cut).
- Content (CONFIRMATORY, 18 tasks): repeated-failure benefit +4.81 pp
  [0.74, 10.00], RRR 11.82% [1.52, 26.87]; task-pass benefit -6.30 pp
  [-15.56, +0.74]; compound p 0.9393 -> REJECTED.
- Raw episode rates (valid rows): NO_MEMORY 44.24% RF, 2.60% pass
  (n=269); TURN_START_SUCCESS 40.74% RF, 7.04% pass (270);
  TURN_START_FAILURE 35.93% RF, 0.74% pass (270); PRE_ACTION_FAILURE
  0.00% RF, 2.97% pass (269); BOTH 0.00% RF, 1.48% pass (270).
- No-trap check (540 rows): pass-rate diff +0.74 pp, 90% CI
  [-0.74, +2.22] (misses the +/-2 pp margin by 0.22 pp — recorded
  unresolved, not failed); steps diff -0.026, 90% CI [-0.063, +0.0037]
  (inside +/-2).
- Study decision: NOT_ESTIMABLE.

## Registration 2 confirmatory rerun (h6-timing-v2) — decision PASS

- Run `h6-51d25af1ed731c35a94c28fe`; 540/540 rows; 0 invalid; 0 cuts;
  0 imputations; 5 host faults retried; empty deviation log.
- 12,676,237 total tokens.
- Timing (CONFIRMATORY, 18/18 tasks): benefit +35.56 pp, 95% CI
  [16.67, 55.93]; RRR 1.00 [1.00, 1.00]; p 0.0019 (adjusted = raw,
  single-member family). Task-pass benefit +1.48 pp [0.00, 4.44],
  p 0.507. Decision SUPPORTED; study PASS; paper artifact CONFIRMATORY
  with zero ineligibility reasons.
- Raw episode rates: PRE_ACTION_FAILURE 0/270 RF (0.00%), 9/270 pass
  (3.33%), mean 5.80 steps; TURN_START_FAILURE 96/270 RF (35.56%),
  5/270 pass (1.85%), mean 5.70 steps.
- An earlier manifest under the same registration completed all 540 rows,
  then failed in the harness finalization step (an option-plumbing defect
  rejected by the analysis guard); abandoned with an operational deviation
  record. Its episode log existed on disk (written by the crashed
  finalization attempts) but was never statistically analyzed before the
  re-execution decision; see the abandoned-manifest section below. The
  confirmatory manifest ran on the fixed, test-covered harness.

## Verification receipts

- Statistics replay: zero model calls, byte-identical for both runs.
- Pilot power transfer verified by pinned manifest hash `5bce2c0c…` and
  power artifact hash `cfaec22f…`; byte-identical pilot replay under the
  rerun harness before launch.
- Trap audits per registration: R1 40.0% trapped / 63.3% non-fixed; R2
  relaunch audit 40.0% / 70.0%; both 30/30 rows, 0 invalid (floors
  0.30 / 0.50).
- Deterministic fake-agent smoke runs repeated twice with identical row,
  trace, and decision hashes before live rows (both registrations).

## Honest limits (must appear in the paper)

- Single model, single quantization, single language (TypeScript),
  synthetic tasks, frozen caps; no cross-project or cross-language claim.
- Task completion did not measurably improve (CI touches zero); pass
  rates are low in every arm (0.74%-7.04%) because caps bind hard.
- Content result: failure wording at turn start lost to success wording
  on task-pass; turn-start failure memory is not established as useful.
- BOTH arm removed repeated failures but passed only 1.48% (descriptive).
- The timing effect concerns repeating a KNOWN, previously observed
  failure with a matched fact available; it is not general learning.
- First registration voided by its own zero-cut rule on one cap-driven
  unclassifiable check; the rerun fixed the rule before new data existed.

## Derived totals (for the paper)

- Combined registered-run episode tokens: 43,377,443 + 12,676,237 = 56,053,680 (~56.1M).
- R1 NO_MEMORY repeated failures: 119 of 269 valid rows (44.24%).
- Wall time, confirmatory rerun: rows completed in about 11 h (0.36-0.83 rows/min observed range across manifests).

## Abandoned registration-2 manifest (h6-timing-v1) — descriptive only

- 540/540 rows completed; episodes.jsonl was written by the crashed finalization attempts, so terminal arm-level outcomes exist on disk. The registered analysis never ran on them; aggregate final-state counts (without arm attribution) were observed during run supervision; the re-execution decision preceded any arm-level analysis.
- Descriptive rates from its episode log: TURN_START_FAILURE 100/270 repeated failures (37.04%), 5/270 passes; PRE_ACTION_FAILURE 0/270 repeated failures, 10/270 passes.
- The kept confirmatory manifest measured a SMALLER effect (96/270 vs 100/270 turn-start repeats), so selection between manifests cannot explain the result.
- Same seeds (6-10) by registration design; the registration pins the seed set.
