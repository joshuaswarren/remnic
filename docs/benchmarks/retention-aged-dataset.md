# Aged-Dataset Retention Bench

Issue #686 PR 2/6.

## Goal

Measure structural properties of Remnic's hot/cold tier policy on a synthetic
1- or 2-year corpus. PR 3/6 will use this bench to tune the production
defaults (`demotionMinAgeDays`, `demotionValueThreshold`,
`promotionValueThreshold`) and decide whether to flip
`lifecyclePolicyEnabled` to `true` by default.

## Design

The bench is **hermetic** — no orchestrator, no QMD, no filesystem. It uses
`decideTierTransition` from `@remnic/core` so the tier-routing computation
is identical to production.

### Synthetic corpus

`generateAgedDataset()` produces a deterministic dataset given a seed:

- **`size`** — total memory count.
- **`horizonDays`** — 365 (1y) for `quick` mode, 730 (2y) for `full` mode.
- **`topicCount`** — number of distinct topics each memory belongs to.
- **`paretoAlpha`** — controls topic-frequency skew (1.16 ≈ Zipf's "80/20").
- **`ageSkew`** — bias toward old (>1) or recent (<1) memories. Default 1.5.
- **`seed`** — deterministic PRNG seed.
- **`nowIso`** — anchors "now" so memory ages are reproducible across runs.

Confidence tiers are spread across the four production tiers based on
topic Pareto rank: hot topics lean explicit/implied, cold-tail topics lean
inferred/speculative. This mirrors the realistic distribution of facts
produced by extraction at scale.

### Metrics emitted (per query, one query per topic)

- **`recall_at_5_full`** — recall@5 against the full corpus.
- **`recall_at_5_hot_only`** — recall@5 against the hot partition (the
  cold partition is removed using the production tier policy).
- **`recall_at_5_delta`** — full minus hot-only.
- **`hot_share`** / **`cold_share`** — fraction of corpus per tier.

Latency per task records `latencyFullMs` (full-corpus rank) and
`latencyHotMs` (hot-only rank); the relative delta is the proxy for the
"index size cost" benefit of demoting cold memories out of the live index.

## Acceptance criteria for PR 3 (default-tuning study)

- Aggregate `recall_at_5_delta` ≤ 0.01 (within 1pp).
- `hot_share` ≤ 0.20 at 2y horizon (≥ 5× hot-index reduction).
- Aggregate `latencyHotMs / latencyFullMs` ≤ 0.20 (linear in corpus size).

If any of these fail, do **not** flip `lifecyclePolicyEnabled` to `true`
by default; instead document findings in PR 3 and re-tune.

## Running

```bash
# Quick mode (200 memories, 1y horizon — fast smoke).
remnic bench run --quick retention-aged-dataset

# Full mode (2000 memories, 2y horizon — the default when --quick is omitted).
remnic bench run retention-aged-dataset
```

The CLI surface uses the `--quick` flag (full mode is the default); other
remnic benchmarks follow the same convention. Results emit JSON
conforming to `BENCHMARK_RESULT_SCHEMA` like every other bench in
`@remnic/bench`.

## Why synthetic

The repo is public and bench fixtures must not contain personal data
(see `CLAUDE.md`). A real long-tail corpus at this scale is unavailable
without leaking real conversations. The synthetic generator is
parameterized so the bench remains useful as the default policy
evolves.
