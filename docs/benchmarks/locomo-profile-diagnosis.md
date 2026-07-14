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
recall X-ray receipts. No paired baseline/real recall receipts are available
in the repository or local result store, so claims that QMD, entity retrieval,
verified recall, or Memory Boxes displaced LCM evidence remain hypotheses.

For benchmark operators, the evidence supports a narrow provisional rule:
use `--runtime-profile baseline` for LoCoMo runs that deliberately use
`replayExtractionMode: "skip"` when the objective is the best score from this
validated configuration. Do not generalize that recommendation to production
agents, LongMemEval, extraction-enabled LoCoMo runs, or other workloads. No
shipped default changes on this evidence.

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

## Acceptance remains blocked on paired recall evidence

The baseline score artifact is recoverable from git history, but the operator
baseline replay state, answer-level traces, and paired recall X-ray receipts
are not available. The committed real artifact alone cannot prove recall
interference. Issue #1879's root-cause acceptance criterion therefore remains
open until an operator captures baseline and real receipts for the same ranked
regression task ids.

The deterministic tool prints those task ids. The next run should preserve,
for each profile and task: served recall tiers, ordered evidence and scores,
token-budget truncation/displacement, final responder answer, and the exact
profile/config hash. Compare multi-hop regressions first, retain a few
single-hop improvements as negative controls, and only then choose between a
recall-composition fix and permanent benchmark-profile guidance.

## Further questions

- Does the multi-hop regression reproduce when the responder answers are
  judged by the same calibrated frontier judge?
- Which recall tier first diverges between profiles on the ranked task ids?
- Is the effect caused by evidence omission, ordering, token-budget pressure,
  or responder distraction despite retaining the same evidence?
- Does enabling extraction for LoCoMo reverse the result, making the current
  guidance specific to skip-extraction replay rather than LoCoMo generally?
