# Paper figures (§6 Results)

Generated figures for the evidence-sprint paper (`docs/paper/main.md` §6). Every
figure is **rendered by a committed script** from committed artifacts + shipped
source — never hand-drawn, never a fabricated number (repo rule 55).

## Regenerate

```bash
pnpm run figures:paper
```

This rewrites all three SVGs in this directory deterministically (byte-identical
across runs — asserted by `tests/paper-figures.test.mjs`). The generator is
`scripts/generate-paper-figures.mjs`; it reads only from committed paths.

## Figures and data status

| Figure | File | Real data | Pending data |
|---|---|---|---|
| 1 — LoCoMo / LongMemEval | `fig1-locomo-longmemeval.svg` | Remnic Tier-L + Tier-F (both benchmarks, real profile) | Mem0 / Zep / Letta (#1747) |
| 2 — MemCorrect 8 metrics | `fig2-memcorrect-metrics.svg` | Remnic-native + prompt-only baseline (Tier-L full matrix, 2026-07-13) | Mem0 / Zep / Letta (#1747, API-key-gated) |
| 3 — TrustScore 8 components | `fig3-trustscore-components.svg` | all 8 (source-extracted weights) | — |

**Legend.** Solid bars are real — every value traces to a committed artifact or
the shipped source. **Hatched bars are DATA-PENDING placeholders**: no value is
rendered until the blocking artifact lands. The pending bars are keyed to the
public artifact schema so the figure auto-upgrades to real bars the instant an
artifact is committed under `docs/benchmarks/results/` (the generator probes for
it on every run; the test covers this auto-upgrade path).

## Provenance (what each real value traces to)

**Figure 1.** The Remnic Tier-L bars trace to:

- `docs/benchmarks/results/2026-07-07-locomo-qwen2.5-7b-32k_latest-47aae03.json`
  — `tier: "local"`, model `qwen2.5-7b-32k:latest` (Q4_K_M), full 1986/1986 QA.
  Plotted metrics: `contains_answer`, `f1`, `llm_judge`, `rouge_l`.
- `docs/benchmarks/results/2026-07-07-longmemeval-qwen2.5-7b-32k_latest-47aae03.json`
  — `tier: "local"`, 500/500 LongMemEval-oracle. Plotted metrics:
  `contains_answer`, `f1`, `llm_judge`, `judge_accuracy`.

Non-`[0,1]` metrics (`locomo_hidden_evidence_id_leak`, `search_hits`) are
reported in each panel's footnote on their own scale, **not** on the accuracy
axis — plotting a leakage guard or a recall-depth count on a 0–1 accuracy axis
would mislead. The `2026-04-20-*-mock000.json` files are mocks and are **never**
cited as results (the generator filters them out; the test asserts this).

Tier-L is the **reproducibility anchor, not the accuracy headline** (per the
paper's honest framing: a 7B-local non-thinking run is modest by design). The
head-to-head vs Mem0/Zep/Letta is the Tier-F panel, which is pending the Tier-F
run (#1728) and the third-party recall adapters (#1747). Competitor
self-reported numbers are **not** echoed here — they are cited-not-reproduced
until the harness reproduces them.

**Figure 2.** The Remnic-native and prompt-only-baseline bars are real —
two committed 40-scenario Tier-L full-matrix artifacts
(`docs/benchmarks/results/2026-07-13-memcorrect-v1-remnic-native-9485f44.json`,
`docs/benchmarks/results/2026-07-13-memcorrect-v1-prompt-only-baseline-9485f44.json`;
see `docs/benchmarks.md` for the run commands and the honest reading of the
floor-identical containment metrics). Mem0 / Zep / Letta bars remain pending
on the #1747 adapter runs (API-key-gated). The eight metric axes, their
directions (`↑ higher` / `↓ lower` / `→ 0`), and the adapter row layout are
keyed to the `MemCorrectLeaderboardRow` schema
(`packages/bench/src/leaderboard-export.ts`) — the public submission format
the #1747 adapters emit. The generator reads
`config.benchmarkOptions.aggregateMetrics` from each committed artifact and
renders real bars automatically.

**Figure 3.** The eight weighted components are extracted at render time from
`DEFAULT_TRUST_WEIGHTS` in `packages/remnic-core/src/trust-score.ts` and
sum-normalized exactly as `computeTrustScore` does at score time. This is a
**system-capability illustration, not a benchmark metric** — TrustScore (#1577)
is a shipped recall-stage feature; surfacing it as a scored number is separate
work (flagged in `main.md` §3.4 / §6.3). The eight factors are: Memory Worth,
Provenance, Faithfulness, Corroboration, Contradiction, Domain Calibration,
Feedback, Recency.

## Design conventions

- Accessible, color-blind-safe palette (Okabe-Ito-derived: Remnic blue
  `#0072B2`, Tier-F orange `#E69F00`, third-party teal/green/pink).
- One scale per panel; mixed-scale metrics demoted to footnotes.
- Provenance footer on every figure naming the source paths and the pending
  blockers.
- Deterministic output: no timestamps, no random IDs, stable ordering, fixed
  3-dp formatting.
