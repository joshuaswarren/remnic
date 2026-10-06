# H2 write path vs read path — preregistration

Status: Scaffolding only. No warm, pilot, or main runs. No results.

## Controlling record

GitHub issue #1959. The build plan in
[comment 4998197561](https://github.com/joshuaswarren/remnic/issues/1959#issuecomment-4998197561)
is the authoritative arm list, dataset rule, and pass rule. Where older
issue-body text disagrees with that comment, the comment wins.

The issue body said SUPPORTED if W+ beats R+ on at least one corpus. That
win rule is superseded. "At least one corpus" is not a win. The
machine-readable copy records that superseded rule as `at-least-one-corpus`
and does not use it.

## Hypothesis

Quoted from issue #1959, then reconciled with the build plan.

H2 (primary): at matched LLM compute (±10% tokens), the write-optimized arm
(W+) beats the read-optimized arm (R+) on end-to-end QA accuracy by ≥5%
relative, corrected p < .05.

The build plan tightens the primary call: H2 is SUPPORTED only when that
gain holds on both main datasets and the fixed tests pass after Holm
correction. A pass on exactly one main dataset is REGIME-DEPENDENT, and
that case is named in the title and abstract. It is not a win.

H2b (mechanism): W+ reduces the `extraction_miss` + `index_miss` share of
failures by ≥30% relative versus R+, while R+ reduces only `retrieval_miss`.
H2b is a mechanism check. It does not by itself make H2 SUPPORTED, and a
failure of H2b does not flip a two-dataset primary pass into a win or a
loss. It is reported beside the primary call.

H0: R+ ≥ W+ at matched compute.

## Decision rule

The main test is W+ versus R+ at matched work. BASE, W+R+, stage knockouts,
and the write×read interaction are side tests. They cannot flip the primary
call.

On the two main datasets, after Holm correction across that family:

- SUPPORTED when W+ beats R+ by at least 5% relative on both datasets and
  the fixed tests pass (Holm-adjusted p < 0.05 on each).
- REGIME-DEPENDENT when exactly one main dataset passes. The title and the
  abstract name that case.
- REJECTED when both main datasets are estimable and the relative gain is
  not positive on either (R+ is at least as good as W+ on both).
- NOT-SUPPORTED for every other estimable result, including a positive gain
  that misses the 5% bar or the p-value bar. That null is reported as a
  null.

The relative gain is `(mean(W+) - mean(R+)) / mean(R+)`. The bootstrap is
10,000 stratified paired draws. Rows that share one generated chat are
grouped in that bootstrap. The significance test is a paired permutation
test. Effect sizes are the relative delta and Cliff's delta.

This scaffold does not draw the bootstrap, run the permutation test, apply
Holm, or compute Cliff's delta. `evaluateH2Decision` reads supplied
per-dataset summaries whose p-values are already Holm-adjusted. A second
stats implementation is not added. Paired intervals and Cohen's d, when a
caller asks for them, go through `packages/bench/src/stats/*`.

The machine-readable copy is
`packages/bench/fixtures/h2-write-vs-read/decision-rule.json`.

## Datasets

Main datasets, each at one frozen revision before any main result is read:

1. LoCoMo, one fixed rev and one item list.
2. The #1954 drift split, one drift-gen version, one seed list, and one
   hash set.

LongMemEval, MINTEval, and MemFail are later checks. They stay outside the
main pass rule unless this preregistration is amended before any main result
is read.

The unit is one item. Pairing keys are corpus, data seed, and run seed.

## Failure labels

The only failure labels are `extraction_miss`, `index_miss`,
`retrieval_miss`, `use_miss`, and `unresolved`. An unclear case stays
`unresolved`. It is not forced into a miss class.

The #1954 instrument records the unclear case as `unattributed`. H2 tables
report that class as `unresolved`. The other four names are the instrument's
names. This change does not add a second attribution engine.

## Compute matching

Match on prompt tokens plus output tokens used by memory work only:

- extract and judge
- dedup and novelty calls
- merge and entity work
- query rewrite, rerank, and model-led search

A W+ and R+ pair for the same source and seed must land within 10%. The
relative gap is `|left - right| / max(left, right)`. A gap above 10% is
`UNMATCHED`. The matcher never changes a token count to force a fit.

Embed cost, answer tokens, wall time, cache tokens, and failed-call tokens
are separate fields. They are reported and they are not added into the match
sum.

The tune grid and its order are frozen before test scores are seen. Tuning
uses train and valid rows only. If no grid point fits, the block stays
`UNMATCHED`. It is not tuned by hand.

The report shows median, p90, total, and the unmatched-block count.

Each ledger row records item, corpus, data seed, run seed, arm, stage, call
ID, provider, model, prompt tokens, output tokens, cache tokens, time in
milliseconds, state, error, and try count.

## Frozen parameters

Frozen in this change:

- the pass rule above, including alpha 0.05, the 5% relative bar, Holm, and
  10,000 bootstrap draws
- the failure labels
- the two main dataset names, and the later-check names that do not count
- the write-key list, the read-key list, and the held-constant boosts
- the four arm files under `packages/bench/fixtures/h2-write-vs-read/arms/`

Those arm files are the starting grid, not a tuned match. No compute-match
grid has been run.

Held constant on every arm: Memory Worth filter on, TrustScore off,
access-count boost on, reinforcement recall boost off, `recencyWeight` 0.2,
outcome boost off at weight 0. The values are in
`write-read-key-allowlist.json`.

W+R+ sets `allTestFlagsOn` true and `armCall` to `all test flags on`.
`matchesReleaseConfig` is false on every arm, including W+R+.

Not frozen yet, because no pilot has run: the final row count N, the final
p-value family membership beyond the two main datasets, the LoCoMo item
list, and the drift-gen version, seed list, and hash set. Those are frozen
before the main run, and pilot rows are not reused in the main run.

## Pilot

The pilot exists to learn spread and which rows are missing. It does not
choose a winner. The final row count and the p-value family are frozen
before the main run. Pilot rows are not reused as main rows.

## Calibration gate

Before any H2 arm runs, the #1954 attribution label check must reach at
least 90% on its fixed set. Accuracy is a proportion in [0, 1]. A missing
accuracy, a non-finite accuracy, a value outside that range (including a
percent such as 89), or an accuracy below 0.90 refuses the run. This
scaffold does not ship that set and does not claim the gate has been met.

## Pre-main gates

Before the main run:

1. Arm diffs use only the fixed write/read key list. A key outside that list
   that changes between arms stops the run. Held-constant keys that differ
   also stop the run.
2. Store and index directories do not mix, and the source, store, and index
   hashes are recorded. Each paired item starts from the same source text
   and a new memory directory and index directory.
3. The token ledger matches provider use on a fake case.
4. The matcher rejects an arm over the 10% limit and labels it `UNMATCHED`.
5. The same fake set run twice produces the same hashes.
6. `npm run preflight:quick` and the bench tests pass.

This change implements the pure checks in items 1 and 4. Items 2, 3, 5, and
the live half of item 6 are not run here.

## Out of scope for this change

No warm, pilot, or main run. No result file. No ingestion adapter, no
drift-gen interference subset, no LoCoMo item list, no calibration items,
and no parametric-exclusion list. The gate `WRITE_VS_READ_RUNS_ENABLED` is
false. Production defaults are unchanged.
