# LoCoMo runtime-profile regression diagnosis

## Technical summary

The July 14 Tier-F LoCoMo comparison reproduces the reported regression on
all 1,986 identical task ids. The `real` profile trails the LCM-only
`baseline` by **0.030 `llm_judge`** (0.444 vs 0.474) and by **0.039 F1**
(0.265 vs 0.304). The regression is concentrated in multi-hop questions:
that category contributes −0.025 of the −0.030 aggregate `llm_judge` delta
and has a −0.104 F1 delta.

This establishes the affected slice, not the recall-side mechanism. The
published score artifacts contain per-task scores but no answer payloads or
recall X-ray receipts. The later private paired capture described below tests
the current runtime rather than reconstructing the July 14 runtime. Claims
that QMD, entity retrieval, verified recall, or Memory Boxes caused the
historical regression therefore remain hypotheses.

For benchmark operators, that historical pair supported a narrow provisional
rule: use `--runtime-profile baseline` for LoCoMo runs that deliberately use
`replayExtractionMode: "skip"` when reproducing the July 14 configuration.
A July 16 current-main capture described below no longer reproduces a
retrieval-structure difference, so this is historical reproduction guidance,
not current-main profile guidance. Do not generalize it to production agents,
LongMemEval, extraction-enabled LoCoMo runs, or other workloads. No shipped
default changes on this evidence.

## Multi-hop accounts for most of the headline judge delta

The table is a same-task join. Delta is `real − baseline`; aggregate
contribution is the category's summed task delta divided by all 1,986 tasks,
so category contributions reconcile exactly to the overall delta.

| Category | Tasks | Baseline `llm_judge` | Real `llm_judge` | Delta | Aggregate contribution | Real wins | Real losses | Ties |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| single-hop | 282 | 0.488 | 0.538 | +0.050 | +0.007 | 93 | 55 | 134 |
| multi-hop | 321 | 0.484 | 0.332 | **−0.153** | **−0.025** | 54 | 107 | 160 |
| temporal | 96 | 0.561 | 0.538 | −0.023 | −0.001 | 25 | 22 | 49 |
| open-domain | 841 | 0.560 | 0.551 | −0.009 | −0.004 | 237 | 257 | 347 |
| adversarial | 446 | 0.277 | 0.245 | −0.032 | −0.007 | 67 | 85 | 294 |
| **Overall** | **1,986** | **0.474** | **0.444** | **−0.030** | **−0.030** | **476** | **526** | **984** |

The single-hop improvement is an important counterexample: the full profile
is not uniformly worse. The observed failure is category-dependent, which is
why a global recall-composition fix would be premature without X-ray evidence.

## Judge-independent F1 confirms a real answer-quality regression

The real artifact's local-judge calibration is unreliable for LoCoMo
(`kappa=0.135`, warning set), while the baseline artifact records
`kappa=0.760`. Therefore `llm_judge` cannot carry the diagnosis alone. F1,
which does not depend on that judge, moves in the same direction overall and
shows the same multi-hop concentration.

| Category | Tasks | Baseline F1 | Real F1 | Delta | Aggregate contribution | Real wins | Real losses | Ties |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| single-hop | 282 | 0.253 | 0.255 | +0.003 | +0.000 | 94 | 90 | 98 |
| multi-hop | 321 | 0.338 | 0.233 | **−0.104** | **−0.017** | 53 | 105 | 163 |
| temporal | 96 | 0.285 | 0.245 | −0.040 | −0.002 | 20 | 31 | 45 |
| open-domain | 841 | 0.369 | 0.337 | −0.031 | −0.013 | 263 | 297 | 281 |
| adversarial | 446 | 0.196 | 0.164 | −0.032 | −0.007 | 74 | 101 | 271 |
| **Overall** | **1,986** | **0.304** | **0.265** | **−0.039** | **−0.039** | **504** | **624** | **858** |

The score evidence supports “multi-hop answer quality regressed under this
profile comparison.” It does not support a causal attribution to any one
retrieval tier.

## Scope, evidence, and deterministic method

Both artifacts identify LoCoMo-10, seed 1, model `opus`, tier `frontier`, and
Remnic git SHA `067634700`. The real artifact is tracked at
`docs/benchmarks/results/2026-07-14-locomo-opus-0676347.json` (SHA-256
`8c7c84264ace71f81a5158d0d46700231571d1c215c5cfaa0fe95101f8a90254`).
The baseline score artifact was intentionally removed from the current tree
after publication, but remains citable in git history at commit `ac0ed654` as
`docs/benchmarks/results/2026-07-14-locomo-opus-0676347-baseline.json`
(SHA-256
`62c32f215de417b277a7a8f4270390e39649af24011fd6d70714a9e133f04765`).

The diagnostic tool validates artifact schemas, comparable dataset/model/seed/
git-SHA/tier fields, identical unique task-id sets, identical per-task metric
sets, and agreement between published aggregates and recomputed per-task
means. It derives historical LoCoMo categories from stable task-id suffixes
when the optional artifact category field is absent, then sorts every output
deterministically.

```bash
git show ac0ed654:docs/benchmarks/results/2026-07-14-locomo-opus-0676347-baseline.json \
  > /tmp/locomo-baseline.json
pnpm --filter @remnic/bench run build
pnpm exec tsx scripts/bench/diagnose-locomo-profile-delta.ts \
  /tmp/locomo-baseline.json \
  docs/benchmarks/results/2026-07-14-locomo-opus-0676347.json

# Judge-independent robustness view
pnpm exec tsx scripts/bench/diagnose-locomo-profile-delta.ts \
  /tmp/locomo-baseline.json \
  docs/benchmarks/results/2026-07-14-locomo-opus-0676347.json \
  --metric f1 --format json
```

## Current main does not reproduce the retrieval-structure divergence

On July 16, 2026, merged main `7d885e2e` captured paired, provider-free recall
receipts for all 321 multi-hop tasks from the historical comparison. Both
captures used LoCoMo-10 dataset SHA-256
`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`,
the same ordered selector (`selectedTaskIdsSha256`
`bbc56610faefc0a65704f713c6c7aa8ce5a7f71ca060a1e3d218c57a514f21b9`),
the same recall-budget algorithm, and skip-extraction replay. Their retrieval
configuration hashes differ as intended:

- baseline: `bec4199d39a1c706276a1cca99cb100a7aa2d588ebc64fcdd1aa3f8fe2f30e88`
- real: `2a87cae27581fe0534e4316888f2a000bf85ce13bcc646f9e99abe1bb41e2bd3`

The strict paired analyzer classified all 321 tasks as
`no-structural-delta`. Every displacement, selection, composition, budget,
mixed, and insufficient-lineage count was zero. The report therefore marks
the dominant multi-hop mechanism `not-supported` (0 of 321). Safe artifact
identities are:

- baseline receipt: `a9ce89899ba7baa22d272b5b774ae661f3f49bcb2eccbd18efb45bd824edf661`
- real receipt: `5d83561b24b8a8530e0f95ee357d138626460f0c24368fe773fe1fb2276bc716`
- paired report: `719ddd7a32c3afca9f0c8f522ee5d57fd2571a35581c929a42294829ef948f47`

The receipts and full report remain in the operator's private benchmark store.
They contain no gold answers or raw content, but are classified restricted and
are not committed. This negative result rules out the proposed current-main
core/LCM structural-displacement explanation on the affected slice. It does
not identify the July 14 historical cause, prove that answer scores are now
equal, or show that a responder would treat identical context identically.

## Paired scored rerun narrows the remaining gap

On July 16, the exact 321-task multi-hop selector was rerun as a paired
`baseline`/`real` matrix with `gpt-5.6-luna` as responder and internal model
and `gpt-5.6-terra` as judge. Both sides used dataset SHA-256
`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`,
selector SHA-256
`bbc56610faefc0a65704f713c6c7aa8ce5a7f71ca060a1e3d218c57a514f21b9`,
the same 321 unique task ids, and launch SHA `3a8f9290`. All 642 tasks
completed without a task-level failure, and both profiles retained a 1.0
hidden-evidence-id safety score.

| Metric | Baseline | Real | Delta (`real - baseline`) | Real wins | Real losses | Ties |
|---|---:|---:|---:|---:|---:|---:|
| `llm_judge` | 0.3050 | 0.2983 | -0.0067 | 11 | 14 | 296 |
| F1 | 0.3100 | 0.3057 | -0.0044 | 16 | 22 | 283 |
| `contains_answer` | 0.0903 | 0.0935 | +0.0031 | 5 | 4 | 312 |

This result was much closer than the historical multi-hop gap, but it did not
establish parity at the time: judge score and F1 remained slightly lower for
`real`, while exact containment was slightly higher. Combined with the
provider-free receipt showing no structural retrieval delta, it shifted the
next investigation toward benchmark-control behavior rather than a
demonstrated core/LCM displacement.

The private result SHA-256 values are
`21cd3c1f6f6c1a89a8d7d432d7004e08d575655e2cdca4addde0952852890397`
(`baseline`) and
`549c31e578a2269d2c4c49ea688a9de2ddeb097fcd9f627a312d1a95f6677708`
(`real`). The run used 242.2365325 locally accounted Codex credits across
1,329 Luna and 410 Terra calls, with zero Sol calls. It remains bounded
diagnostic evidence, not a full-LoCoMo artifact. Its late reproducibility
manifest also recorded an unrelated shared-checkout branch switch as dirty;
the result files retain the launch-time SHA, but this envelope is deliberately
not promoted or used for a leaderboard claim.

## Final bounded rerun establishes benchmark-control parity

PR #2133 (`92fbf9985`) hardened the paired-answer replay control around the
final matched 321-task rerun. A `real` task can reuse a `baseline` answer only
after the complete responder-facing input matches, including a non-secret
responder identity and every responder-affecting provider option. Partial or
aborted runs clear staged replay entries, and cross-profile reuse in the
opposite direction is rejected.

The run used the exact 321-task multi-hop selector whose ordered task-id
SHA-256 is
`bbc56610faefc0a65704f713c6c7aa8ce5a7f71ca060a1e3d218c57a514f21b9`.
Baseline and `real` used the same responder, judge, model settings, task order,
and recall budget; all 321 `real` answers were reused only after the full
responder-facing input matched. The public durable receipt is the
[#1879 acceptance comment](https://github.com/joshuaswarren/remnic/issues/1879#issuecomment-5061446119).
The bounded raw results remain private because they contain benchmark answers
and recalled context.

| Metric | Baseline | Real | Delta |
|---|---:|---:|---:|
| `llm_judge` | 0.3062305296 | 0.3062305296 | 0 |
| F1 | 0.3014345813 | 0.3014345813 | 0 |
| `contains_answer` | 0.0934579439 | 0.0934579439 | 0 |
| ROUGE-L | 0.2827454650 | 0.2827454650 | 0 |

This bounded control satisfies #1879's narrow profile-diagnosis acceptance:
current main does not show a recall-side structural regression when responder
inputs match. It is not an uncapped, calibrated LoCoMo leaderboard artifact
and does not satisfy #1878's separate 1,986-task acceptance gate. The
resolution is a benchmark-side variance control, not a retrieval improvement.
The answer-support gate remains an explicit, reversible opt-in rather than an
implicit difference between `baseline` and `real`.
