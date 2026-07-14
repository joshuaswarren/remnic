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

The `docs/benchmarks/results/` directory now contains the **first real
Tier L artifacts** (issue #1574), produced on an RTX 3090 lab box under
the `local-lab` runtime profile. These are real Remnic recall-stack runs
against the full LoCoMo-10 and LongMemEval-oracle datasets (both uncapped
full runs):

- `2026-07-07-locomo-qwen2.5-7b-32k_latest-47aae03.json` — qwen2.5:7b-instruct
  (Q4_K_M), seed 1, **full run (1986/1986 QA across all 10 conversations)**.
  Metrics: `contains_answer=0.0831`, `f1=0.1217`, `llm_judge=0.2243`,
  `rouge_l=0.1177`, hidden-evidence-id leak = 1.0 (no cheating). 0 empty
  answers; 1885 judge model calls (cache absorbs the ~5% repeated answers).
- `2026-07-07-longmemeval-qwen2.5-7b-32k_latest-47aae03.json` — same model,
  seed 1, **full run (500/500 oracle questions)**. Metrics:
  `contains_answer=0.098`, `f1=0.0708`, `judge_accuracy=0.186`,
  `llm_judge=0.186`, `search_hits=8.52` (recall surfaces ~8.5 evidence
  hits/query). 0 empty answers; 407 judge model calls.

Both carry `tier: "local"` and
`hardware: { gpu: "NVIDIA RTX 3090", vramGb: 24, quantization: "Q4_K_M" }`.
`judgeCalibration` is intentionally **omitted**: no frontier (cloud) judge
credentials were available on the lab box, so Cohen's kappa could not be
computed — responder and judge are the same qwen2.5:7b-instruct model, which
carries a known self-preference caveat acceptable for Tier L regression.
Judge-call counts: locomo 1885/1986 and longmemeval 407/500 (the
content-keyed judge cache absorbs repeated/identical answers).

Single-flag ablation deltas against this Tier L baseline (memory-worth,
contradiction-scan, graph-recall) are in
[`docs/benchmarks/ablations.md`](./benchmarks/ablations.md) (issue #1730).
At 7B-Q4 single-seed no cell moves any metric outside the run-to-run noise
band, so no shipped default is changed by that ablation.

The July 14 Tier-F `real` versus LCM-only `baseline` LoCoMo comparison is
diagnosed in
[`docs/benchmarks/locomo-profile-diagnosis.md`](./benchmarks/locomo-profile-diagnosis.md).
The regression is concentrated in multi-hop questions and is present on
judge-independent F1, but paired recall X-ray receipts are not available, so
the recall-side mechanism is not yet established. Pending that evidence,
benchmark operators should use the `baseline` profile only for LoCoMo's
skip-extraction replay path when optimizing this measured configuration; this
is not production guidance and does not change shipped defaults.

An opt-in answer-time support gate is available as an **empty-recall
abstention foundation**. It defaults to `false`. To enable it for a CLI run,
put the following top-level setting in the JSON passed to the existing
`--remnic-config` option (a nested `remnic` object is also accepted by the
runtime-profile loader):

```json
{
  "answerSupportGate": true
}
```

```bash
remnic bench run locomo --runtime-profile real \
  --remnic-config ./locomo-real.json
```

Boolean-like strings (`true/false`, `1/0`, `yes/no`, and `on/off`) are
validated explicitly. With the gate enabled, a successful empty responder
context instructs the responder to answer `unknown`. Adapters may additionally
provide an exact-context support assessment; `weak` requires a positive
matched-evidence count and a finite maximum score below an explicit threshold.
Backend failure is recorded separately and never forces abstention. The current
gate lives in the shared published-benchmark harness, so it applies uniformly
to LoCoMo and LongMemEval without inspecting benchmark categories or answers.
The Remnic benchmark adapter does not yet expose that bounded same-context
confidence signal, so non-empty recall remains `unavailable` rather than being
guessed weak from auxiliary zero-hit searches.

This foundation does **not** establish issue #1878's acceptance metrics. A new
calibrated, uncapped 1,986-task real-profile LoCoMo run, with the required
responder/judge credentials and published artifact, is still required before
claiming adversarial lift or answerable-category preservation.

The two `*-mock000.json` files remain as **pipeline examples** with
`datasetVersion: "mock-fixture"` and placeholder scores; **do not cite
them publicly**. They will be removed once full uncapped Tier L runs
replace the staged baselines.

## Tier F pipeline validation — Opus via Claude Code (claude -p)

Issue #1728 added a `claude-cli` bench provider (#1735, `26a6ed92b`) that
runs Opus 4.8 through Claude Code headless (`claude -p`) from an isolated
empty temp workspace with tools disabled. This lets Remnic validate the
full published-benchmark pipeline against a frontier model without a raw
Anthropic API budget — the operator's Claude Max subscription provides the
compute.

**Provenance labeling:** these artifacts are labeled **"Opus via Claude Code"**
(`provider: "claude-cli"`, `model: "opus"` on the artifact config) and retain
`tier: "frontier"` when they satisfy the Tier-F artifact contract. Claude Code
is a valid research harness; its entitlement and invocation details are part of
the provenance record alongside the model and benchmark configuration. A raw
Anthropic API run and a Claude Code run are distinct measurement paths, not a
valid-versus-invalid hierarchy. Reviewers must be able to reproduce the
declared harness and configuration, and bounded trials must remain clearly
identified as partial-coverage artifacts rather than full leaderboard runs.
These artifacts are therefore pipeline-validation evidence until the complete
uncapped benchmark coverage required by the publication rubric is executed.

### Bounded-slice results (2026-07-08, commit 798fe8a7a)

| Benchmark | Tasks | Wall time | Key metrics |
|---|---|---|---|
| LoCoMo | 100/1986 (trial) | 965 s (~16 min) | `contains_answer=0.120`, `f1=0.277`, `llm_judge=0.397`, `rouge_l=0.255`, evidence-id-leak=1.0 |
| LongMemEval | 50/500 (limit) | 580 s (~10 min) | `contains_answer=0.520`, `f1=0.508`, `judge_accuracy=0.820`, `search_hits=9.91` |

Both used `--runtime-profile baseline --system-provider claude-cli
--system-model opus --judge-provider claude-cli --judge-model opus`
(responder + judge = Opus via Claude Code). Artifacts:

- `docs/benchmarks/results/2026-07-08-locomo-opus-via-claude-code-trial100-798fe8a.json`
  (sha256 `e853891d…`)
- `docs/benchmarks/results/2026-07-08-longmemeval-opus-via-claude-code-trial50-798fe8a.json`
  (sha256 `56dafb93…`)

Note on artifact fields: the runner records `meta.mode: "full"` (full-mode
scoring pipeline) with `config.benchmarkOptions.trialLimit` bounding the
task count — the "(trial)" labels above and the `trial100`/`trial50` filename
segments carry the partial-coverage signal. These historical bounded artifacts
omit a top-level `tier` field; the published-artifact compatibility rule treats
an absent tier as `frontier`, while new artifacts should record
`tier: "frontier"` explicitly alongside their Claude Code provenance. They are
not full leaderboard results because coverage is capped, not because Claude
Code is an invalid research harness.

A small number of tasks (9/100 locomo, 3/50 longmemeval) hit intermittent
`claude -p` subprocess failures (exit 1) and scored 0 on those metrics;
the provider's retry logic absorbed transient errors but not these.
`internalProvider: null` — the baseline runtime profile uses the Remnic
LCM chunking/extraction stack without a separate internal LLM gateway.

### Full-run cost estimate (not yet executed)

Based on the measured per-task wall times (965 s / 100 = ~9.7 s locomo,
580 s / 50 = ~11.6 s longmemeval — wall time includes ingestion, recall,
responder, and judge; mean responder query latency alone was 7.5 s / 9.6 s):

| Run | Tasks | Estimated wall time |
|---|---|---|
| LoCoMo full | 1986 | ~5.3 h |
| LongMemEval full | 500 | ~1.6 h |
| **Total** | **2486** | **~6.9 h** |

This fits an 8-hour budget but would consume a significant fraction
of the operator's weekly Claude Max Opus quota. The full run is an
**explicitly user-approved follow-up**: the bounded slices above prove
the pipeline is correct; the full Tier F pass (or the raw-API headline
number) awaits quota authorization.

To build a publishable artifact from a finished run's stored result, see
`scripts/bench/build-artifact-from-result.ts` (bridges `BenchmarkResult` →
`BenchmarkArtifact`, stamping the two-tier `tier`/`hardware` envelope). Real
numbers are committed as `BenchmarkArtifact v1` JSON files (one per
benchmark × model × run), rendered on <https://remnic.ai/benchmarks>, and
called out in `CHANGELOG.md` under the release that introduced them.

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
[`docs/benchmarks/memcorrect.md`](./benchmarks/memcorrect.md).

**Tier-L full-matrix artifacts (2026-07-13, commit `9485f448`, RTX 3090):**
two committed 40-scenario `mode: full` runs (seed `0xc077e7`) —
`results/2026-07-13-memcorrect-v1-remnic-native-9485f44.json`
(runtime profile `real`: Remnic's shipped defaults with the fact pipeline
and Correction Contract active; extraction + correction classification on
`qwen2.5-7b-32k:latest`; pinned config in
`configs/memcorrect-lab-remnic-config.json`) and
`results/2026-07-13-memcorrect-v1-prompt-only-baseline-9485f44.json`
(the hermetic append-only floor). Adapter selection is a CLI mode:
`remnic bench run memcorrect-v1 --memcorrect-adapter <remnic|prompt-only>`;
the Remnic adapter routes `correct()` through the Correction Contract
(plan + confirmed apply) with the plain turn path as fallback.

**Honest reading of the Tier-L numbers:** both adapters land on the floor
for the containment-scored metrics (`uptake_at_next = 0`,
`non_resurrection = 0`, `false_apply = 1`). Per-scenario tracing shows the
Remnic correction path itself works — the fact is extracted, the contract
plan applies, the stored fact is retired — but stale content still reaches
recall through the 7B classify model drafting retire-only actions (no
corrected replacement fact), surviving behavioral-profile lines, and
verbatim LCM turn evidence quoting the outdated statement. MemCorrect is
deliberately strict: serving a stale value anywhere in recall context fails
the probe. These artifacts are the reproducibility anchor for that finding,
not a leaderboard bragging number.

## Ethics

- No dataset file or raw LLM trace is committed to this repo.
- No API key, credential, or private profile appears in any artifact.
- Artifact contents are validated by `parseBenchmarkArtifact()` before
  serialization; anything that fails the schema is rejected at build
  time, not silently elided.
