# Remnic published-benchmark numbers

Remnic evaluates against a broad published memory-agent suite, not just
single-turn retrieval fixtures. The current `@remnic/bench` published
registry includes:

| Benchmark | Capability measured | Current harness support |
| --- | --- | --- |
| AMA-Bench | Long-horizon agent trajectories | Action/observation trajectory cues, recommended judge protocol hooks |
| MemoryArena | Interdependent multi-session planning | Structured plan-field and dependency cue recall |
| AMemGym | Interactive personalization | Latest-state and supersession-safe recall |
| LongMemEval | Long-term conversational memory | Temporal/session cue recall without gold-session routing |
| LoCoMo | Long conversation memory | Dialogue, speaker, and session cue recall |
| BEAM | Extreme-scale conversation memory | Query-visible plan/source/chat-id cue recall |
| PersonaMem-v2 | Implicit preference learning | Preference/persona cue recall and latest preference resolution |
| MemoryAgentBench | Event/date/keypoint memory | Event, date, keypoint, and conflict-resolution cue recall |
| MemBench | Factual vs reflective recall | Step/time cue recall with target ids reserved for scoring |

The benchmark suite also includes Remnic-owned retrieval, ingestion, and
assistant-quality benchmarks for regression testing. See
[`docs/benchmarks/runbook.md`](./benchmarks/runbook.md) for the exact
steps to run full published benchmarks and publish artifacts.

The runner plumbing is in `@remnic/bench` — notably:

- Published benchmark registry: `packages/bench/src/registry.ts`
- Full-feature runtime profiles: `packages/bench/src/runtime-profiles.ts`
- Dataset loaders and full-mode guards under
  `packages/bench/src/benchmarks/published/`
- Artifact schema: `BenchmarkArtifact` v1
  ([issue #566 slice 3](https://github.com/joshuaswarren/remnic/pull/581))
- CI regression guard: `.github/workflows/bench-smoke.yml`
  ([issue #566 slice 7](https://github.com/joshuaswarren/remnic/pull/584))
- Explicit cue recall hardening: issues #841 through #850
- Local-lab runtime profile: `packages/bench/profiles/local-lab-3090.json`
  (issue #1573 — single-GPU sequential-phase profile)
- Judge-result cache: `packages/bench/src/judges/judge-cache.ts`
  (issue #1573 — zero judge calls on unchanged answers)
- Cross-tier judge calibration: `packages/bench/src/judges/calibration-slice.ts`
  (issue #1573 — Cohen's kappa between local and frontier judges)

## What to expect

Quick mode is for smoke testing harness wiring. Full mode is the only
mode intended for leaderboard-style claims. A leaderboard-ready run
should:

- Use full datasets, not bundled smoke fixtures.
- Record dataset versions, seed, model id, judge id, runtime profile,
  commit SHA, and artifact manifest.
- Run in an isolated benchmark memory store, not a production Remnic
  memory directory.
- Enable the full Remnic recall stack, including QMD, graph/temporal
  recall where configured, explicit cue recall, and benchmark-specific
  visible cue formatting.
- Keep hidden benchmark fields out of answering recall. Gold answers,
  target ids, source ids, final state, and evidence labels are scoring
  or reporting metadata unless they also appear in stored memory or the
  user-visible question.

The `docs/benchmarks/results/` directory may contain **mock placeholder
artifacts** with `datasetVersion: "mock-fixture"` so the pipeline can be
verified on a fresh clone. **Do not cite mock numbers publicly.**

When real numbers land they will be:

- Committed to `docs/benchmarks/results/` as `BenchmarkArtifact v1`
  JSON files (one per benchmark × model × run).
- Rendered on <https://remnic.ai/benchmarks>.
- Called out in `CHANGELOG.md` under the release that introduced them.

## Two-tier benchmark protocol

Remnic benchmark runs are categorized into two tiers that **must never
be conflated** in any published number, leaderboard claim, or
regression graph. The tier is recorded on every artifact as
`tier: "local" | "frontier"`.

### Tier L — local regression

| Attribute | Value |
|---|---|
| Profile | `local-lab-3090` (or a custom local-lab manifest) |
| Models | Operator-hosted (Ollama, vLLM, llama.cpp); pinned quant + seed |
| Cost | Free — runs entirely on local hardware |
| Purpose | Nightly/on-demand trend lines, ablations, iteration speed |
| Judge | Local judge model; calibrated against Tier F via Cohen's kappa |

Tier L artifacts carry `hardware: { gpu, vramGb, quantization }` so the
exact deployment is reproducible. A Tier L number is **never** a
public leaderboard claim.

### Tier F — frontier leaderboard

| Attribute | Value |
|---|---|
| Profile | Cloud providers (Anthropic, OpenAI-compatible, LiteLLM) |
| Models | Frontier API models |
| Cost | Paid — bounded by the judge-result cache on re-runs |
| Purpose | Public claims, release-time validation, cross-system comparison |
| Judge | Frontier judge (the gold standard) |

### Why the tiers stay separate

A Tier L score reflects a *specific local model at a specific
quantization on specific hardware* — it is a regression signal, not a
capability ceiling. A Tier F score reflects Remnic's recall quality
under a frontier model. Publishing a Tier L number without the tier
label, hardware, and quantization is misleading. **Tier L artifacts
MUST include `hardware`** (the protocol requires it; the parser
validates its shape when present but does not reject a local artifact
that omits it — reviewers and publishers must enforce this invariant).

### Cross-tier judge calibration

Before trusting a Tier L judge for regression, run:

```bash
remnic bench judge-calibrate --benchmark locomo \
  --local-lab-manifest packages/bench/profiles/local-lab-3090.json \
  --judge-provider anthropic --judge-model <frontier-judge-id>
```

This scores a fixed 50-question calibration slice with both the local
and frontier judges and reports **Cohen's kappa**. The kappa is
persisted (`~/.remnic/bench/calibration/`) and lands in subsequent
Tier L artifacts as
`judgeCalibration: { kappa, sampleSize, threshold, warning }`.
A kappa below **0.7** renders a loud "local judge unreliable for this
benchmark" warning in the report and on the artifact. The calibration
slice is question-ids-only — no dataset content is committed (per the
ethics contract below).

### Judge-result cache

Both tiers benefit from the content-keyed judge cache
(`packages/bench/src/judges/judge-cache.ts`). Re-running a benchmark
with **unchanged answers performs zero judge model calls** — observable
via the judge-call counter in the report. This makes iterative
development affordable on both tiers. Disable with `--no-judge-cache`
when forced re-judging is needed; point the cache at a custom directory
with `--judge-cache-dir`.

## Reproducibility

Every artifact records:

- `schemaVersion` + `benchmarkId` + `datasetVersion`
- `system.{name, version, gitSha}` (Remnic version + commit SHA)
- `model` + `seed`
- `startedAt` + `finishedAt` + `durationMs`
- `env.{node, os, arch?}`

Full-suite benchmark directories should also include the run config,
dataset manifest, artifact manifest, and provider/judge configuration
with secrets redacted. This is what lets another operator re-run the
same benchmark against the same Remnic commit and explain any score
movement.

To re-run a published number:

```bash
# From the repo root
git checkout <artifact.system.gitSha>
pnpm install && pnpm --filter @remnic/core run build
# Follow docs/benchmarks/runbook.md with the same --seed and --model.
```

## Cue Recall And Leaderboard Safety

Issues #841 through #850 added a shared rule for all published
benchmarks: Remnic may use exact cues only when those cues are visible in
the user question or were stored in the memory transcript. Harnesses may
add visible anchor text derived from stored messages, but they must strip
those anchors before answer scoring when the anchor is not part of the
real conversation.

This keeps the benchmark closer to how Remnic is used in production:
explicit dates, turn numbers, plan ids, speaker names, step labels,
preference updates, and keypoint names help retrieve precise evidence,
while hidden gold metadata remains unavailable to the answerer.

## MemCorrect (open correction benchmark)

Remnic also publishes **MemCorrect v1** (`memcorrect-v1`), an open
correction / steerability benchmark that measures whether a memory system
can be *corrected*: uptake speed, non-resurrection under maintenance and
re-ingest, collateral damage to unrelated memories, scope precision,
false-apply, and re-assertion. It is system-agnostic — any memory system
that implements the `MemCorrectSystemAdapter` interface can be scored.
Methodology, metric definitions, and the submission contract are in
[`docs/benchmarks/memcorrect.md`](./benchmarks/memcorrect.md). Lab
artifacts land in `docs/benchmarks/results/` once the local-lab Tier-L run
completes; until then the hermetic synthetic-corpus smoke (`remnic bench run
memcorrect-v1 --quick`) is the reproducible in-tree check. By default this
exercises the Remnic-native adapter (the bench `system`); the prompt-only
baseline is a programmatic adapter (see `runner.test.ts`), not a CLI mode.

## Ethics

- No dataset file or raw LLM trace is committed to this repo.
- No API key, credential, or private profile appears in any artifact.
- Artifact contents are validated by `parseBenchmarkArtifact()` before
  serialization; anything that fails the schema is rejected at build
  time, not silently elided.
