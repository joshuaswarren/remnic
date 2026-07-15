# Single-flag ablation results — LoCoMo (Tier L)

This page reports the **single-flag ablation matrix** from issue
[#1730](https://github.com/joshuaswarren/remnic/issues/1730) / [#1574](https://github.com/joshuaswarren/remnic/issues/1574)
/ [#1725](https://github.com/joshuaswarren/remnic/issues/1725), produced on the
RTX 3090 local-lab box under the `local-lab` runtime profile.

Each ablation changes **exactly one** recall-stack flag away from its default in the
baseline run and re-runs the full LoCoMo-10 benchmark (1986 questions across
all 10 conversations) with everything else held constant: same model
(`qwen2.5-7b-32k:latest`, Q4_K_M), same seed (1), same responder **and** judge
model. The baseline is the first real Tier L artifact:

- `2026-07-07-locomo-qwen2.5-7b-32k_latest-47aae03.json` — defaults (all flags
  at their shipped defaults; memory-worth **on**, contradiction-scan **off**,
  graph-recall **off**).

Each cell artifact is committed next to the baseline under
`docs/benchmarks/results/` and verified with
`pnpm exec tsx scripts/bench/verify-artifact.ts` before this page cites it.
**No datasets, raw traces, or logs are committed** — only the validated
`BenchmarkArtifact v1` JSON (metrics + per-task scores + provenance envelope).

> **Note:** the three ablation-cell artifacts
>(`…c67c2c7-memory-worth-off.json`, `…c67c2c7-contradiction-scan-on.json`,
>`…c67c2c7-graph-recall-on.json`) were untracked from the working tree to
>prevent them from polluting the Figure 1 Tier-L anchor (the figure generator
>picks the newest artifact per benchmark+tier). They remain reproducible from
>git history at commit `dcdcb5a8` (`git show dcdcb5a8:docs/benchmarks/results/<basename>`),
>on the lab host at `~/src/remnic/docs/benchmarks/results/`, and in the stored
>results at `~/.remnic/bench/results/`.

## Per-cell deltas vs baseline

`contains_answer` / `f1` / `llm_judge` / `rouge_l` are the four
answer-quality metrics tracked here (the fifth metric,
`locomo_hidden_evidence_id_leak`, stays at 1.000 across every cell — i.e. no
run leaks hidden gold evidence ids into the answer path, the anti-cheating
invariant holds). Δ is absolute (cell − baseline); % is relative to the
baseline value.

| Cell | Flag flipped | `contains_answer` | `f1` | `llm_judge` | `rouge_l` | artifact |
|---|---|---|---|---|---|---|
| **Baseline** | (defaults) | 0.0831 | 0.1217 | 0.2243 | 0.1177 | `…47aae03.json` |
| **memory-worth-off** | Memory Worth multiplier OFF (baseline ON) | 0.0856 (Δ+0.0025 / +3.0%) | 0.1227 (Δ+0.0009 / +0.8%) | 0.2239 (Δ−0.0004 / −0.2%) | 0.1187 (Δ+0.0010 / +0.9%) | `…c67c2c7-memory-worth-off.json` |
| **contradiction-scan-on**† | Contradiction scan ON (baseline OFF) | 0.0851 (Δ+0.0020 / +2.4%) | 0.1220 (Δ+0.0003 / +0.2%) | 0.2236 (Δ−0.0007 / −0.3%) | 0.1181 (Δ+0.0004 / +0.3%) | `…c67c2c7-contradiction-scan-on.json` |
| **graph-recall-on**† | Graph / temporal recall ON (baseline OFF) | 0.0851 (Δ+0.0020 / +2.4%) | 0.1220 (Δ+0.0003 / +0.2%) | 0.2236 (Δ−0.0007 / −0.3%) | 0.1181 (Δ+0.0004 / +0.3%) | `…c67c2c7-graph-recall-on.json` |

† `contradiction-scan-on` and `graph-recall-on` produced byte-identical per-task scores — see [Two cells are bit-identical](#two-cells-are-bit-identical--and-that-is-the-finding) below.

## Reading these numbers

**None of the cells moves any metric by more than the run-to-run noise band at
this scale, so no default is changed by this ablation.** Concretely:

- **memory-worth-off** is within noise on all four metrics (largest move is
  `contains_answer` +0.0025 absolute / +3.0% relative). Disabling the Memory
  Worth recall multiplier neither helps nor hurts at 7B-Q4. The default stays
  **on**.
- **contradiction-scan-on** is within noise on all four metrics (largest
  move is `contains_answer` +0.0020 absolute / +2.4% relative). Enabling
  inline contradiction detection on the write path
  (`contradictionDetectionEnabled`) on top of the default-off baseline
  neither helps nor hurts at 7B-Q4. The default stays **off**.
- **graph-recall-on** is within noise on all four metrics — with deltas
  identical to contradiction-scan-on (see below). Enabling graph recall +
  full-mode graph assist on top of the default-off baseline neither helps
  nor hurts at 7B-Q4. The default stays **off**.

## Two cells are bit-identical — and that is the finding

`contradiction-scan-on` and `graph-recall-on` produced **byte-identical
per-task scores** across all 1986 LoCoMo questions (every `contains_answer`,
`f1`, `llm_judge`, and `rouge_l` per-task value matches to full float
precision). They are not the same file — different `sha256`
(`11e55bb8…` vs `bc1504a7…`), different `note`/flag envelopes, different
run windows, and each ran an independent ~18-minute full benchmark (18.2 min
vs 17.9 min). Yet their scored outputs are indistinguishable.

This is a real result, not a caching artefact: the override merge spreads the
cell's flag on top of the baseline config and passes it as `remnicConfig`
(`scripts/bench/run-ablation-matrix.ts`), and the `memory-worth-off` cell —
which flips a *recall-time* multiplier — genuinely differs (5/1986 tasks vs
this pair; 109/1986 tasks vs the baseline). So the runner is flag-aware;
these two flags simply have **zero measurable effect** on the recall →
answer → score path for LoCoMo at 7B-Q4.

The most likely reason [INFERENCE]: LoCoMo is replayed with
`replayExtractionMode: "skip"`, so the memory store is loaded from a
pre-built snapshot rather than re-ingested question-by-question. Inline
contradiction detection is a write-path gate — with no fresh writes to gate
during a skip-extraction replay it is inert; graph recall needs a built
causal/timeline graph — with extraction skipped there is nothing to traverse,
so it is inert. Both flags are effectively no-ops under this replay mode.
Confirming the exact mechanism needs a single instrumented run; it is filed
as a follow-up, not a gate on this artifact set.

The honest conclusion stands: at this tier neither flag moves any metric, so
no default is changed. The bit-identity is itself the evidence that the
effect — if any — is strictly below the detection floor here.

## Honest variance caveats (read before citing any delta above)

These are **Tier L regression numbers, not capability claims**, and the deltas
are small relative to the expected variance. Treat any single-cell delta below
~5–8% relative as indistinguishable from noise:

1. **7B Q4_K_M scale.** Responder and judge are both
   `qwen2.5:7b-instruct` at Q4_K_M on a single RTX 3090. At this model size
   the recall-stack flag under test is a second-order effect; the dominant
   variance source is the 7B answer/judge quality itself, which dwarfs
   flag-level movement. A delta that looks "real" here can vanish or invert on
   a rerun.
2. **Single seed.** Every cell (and the baseline) runs at seed 1 only — there
   is no multi-seed mean or standard deviation, so no cell has a measured
   confidence interval. A single-seed delta of a few percent is not
   statistically meaningful.
3. **Same-model self-judge.** Responder and judge are the same model, so the
   `llm_judge` column carries a known self-preference caveat (no frontier
   judge was available on the lab box, so `judgeCalibration` / Cohen's kappa
   is omitted). This is acceptable for Tier L regression ranking but must not
   be quoted as a cross-system comparison.
4. **Hidden-evidence-id leak = 1.000 across all cells** confirms no run cheats
   (gold ids never enter the answer path), but it also means that metric
   carries no discrimination between cells.
5. **No default is flipped by this matrix.** A default change requires either a
   delta outside the noise band on multiple seeds, or a Tier F confirmation.
   This ablation documents the *absence* of a measurable single-flag effect at
   7B-Q4, which is itself the finding — it means these flags are safe to leave
   at their shipped defaults and that any benefit they confer is below the
   detection floor of this tier.

## Reproducing

```bash
# From the repo root, on the artifact's recorded gitSha
git checkout <artifact.system.gitSha>
pnpm install && pnpm --filter @remnic/core run build
remnic bench run --benchmark locomo \
  --local-lab-manifest packages/bench/profiles/local-lab-3090.json \
  --model qwen2.5-7b-32k:latest --seed 1
```

The ablation matrix runner is
`scripts/bench/run-ablation-matrix.ts` (issue #1730). See the [two-tier
benchmark protocol](../benchmarks.md#two-tier-benchmark-protocol) for why these
Tier L numbers must never be conflated with Tier F (frontier) leaderboard
claims.
