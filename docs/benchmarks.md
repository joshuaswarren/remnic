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

The July 14 Tier-F `real` versus LCM-only `baseline` LoCoMo comparison and its
current-main follow-ups are diagnosed in
[`docs/benchmarks/locomo-profile-diagnosis.md`](./benchmarks/locomo-profile-diagnosis.md).
The historical regression was concentrated in multi-hop questions and present
on judge-independent F1. A fresh current-main paired capture of the same 321
tasks with the same model, judge, seed, and recall budget yielded
`llm_judge` -0.0025 (14 real wins, 13 losses, 294 ties). The differing
answers reused the same recalled evidence in sampled records, so the result
does not establish a retrieval-side regression or causal mechanism. The old
`baseline` recommendation is therefore historical reproduction guidance for
the July 14 configuration, not current-main or production guidance, and no
shipped default changes on this evidence.

An answer-time support gate is available as an opt-in read-time faithfulness
control. It must be enabled explicitly for either runtime profile:

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
validated explicitly. With the gate enabled, empty or weak exact-context
support instructs the responder to answer `unknown`. The Remnic adapter scores
only the final context supplied to the responder; it does not infer weakness
from a separate zero-hit search. `answerSupportMinCoverage` controls the
bounded lexical coverage threshold (default `0.34`, valid range `(0, 1]`).
Backend failure is recorded separately and never forces abstention. The current
gate lives in the shared published-benchmark harness, so it applies uniformly
to LoCoMo and LongMemEval without inspecting benchmark categories or answers.
For `replayExtractionMode: "skip"`, the adapter now defaults to LCM-first
composition: extraction-dependent core recall receives no budget, while
verbatim LCM search/summary evidence remains available. Set
`skipExtractionLcmFirst: false` to reproduce the previous composition for an
ablation. This policy is generic to skip-extraction replay and does not inspect
LoCoMo categories or gold answers.

This foundation does **not** establish issue #1878's acceptance metrics. A new
calibrated, uncapped 1,986-task real-profile LoCoMo run, with the required
responder/judge credentials and published artifact, is still required before
claiming adversarial lift or answerable-category preservation.

### Build Week paired LoCoMo multi-hop diagnostic (2026-07-16)

Merged launch head `3a8f9290` ran the same ordered 321-task multi-hop selector
under `baseline` and `real`. Both profiles used `gpt-5.6-luna` for responder
and internal work, `gpt-5.6-terra` for judging, seed 0, normal service, and
serialized trials. Both completed 321/321 tasks without a task-level failure.
The dataset SHA-256 is
`79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`;
the canonical selected-task-list SHA-256 is
`bbc56610faefc0a65704f713c6c7aa8ce5a7f71ca060a1e3d218c57a514f21b9`.

| Metric | Baseline | Real | Delta (`real - baseline`) |
|---|---:|---:|---:|
| `llm_judge` | 0.3050 | 0.2983 | -0.0067 |
| F1 | 0.3100 | 0.3057 | -0.0044 |
| `contains_answer` | 0.0903 | 0.0935 | +0.0031 |
| hidden-evidence-id safety | 1.0000 | 1.0000 | 0.0000 |

The run-scoped ledger receipt records 242.2365325 credits, 1,329 Luna calls,
410 Terra calls, and zero Sol calls. Baseline and real result SHA-256 values
are, respectively,
`21cd3c1f6f6c1a89a8d7d432d7004e08d575655e2cdca4addde0952852890397`
and
`549c31e578a2269d2c4c49ea688a9de2ddeb097fcd9f627a312d1a95f6677708`.
The raw results and report cards remain private because they contain questions,
answers, and recalled context.

This is bounded paired evidence, not a LoCoMo leaderboard result. The exact
selector is stored in each result, and both artifact promotion and the full
public-matrix verifier reject `taskSelection` by design. The pinned calibration
source result was absent from this host, so Terra's absolute score is not
described as calibrated or compared to external leaderboards; F1 and
`contains_answer` are reported alongside it. A late manifest regeneration also
observed an unrelated shared-checkout branch switch and marked its Git envelope
dirty. The result files retain launch SHA `3a8f9290`, but the dirty manifest is
not publication evidence. This diagnostic does not cover LoCoMo's adversarial,
single-hop, temporal, or open-domain categories and cannot satisfy #1878.

### Build Week GPT-5.6 full LongMemEval (2026-07-17)

Source head `810f36ae`, Remnic 9.7.6, completed the uncapped
LongMemEval-oracle matrix: 500/500 tasks with zero task failures. The `real`
profile used fresh isolated direct-adapter stores, never a production Remnic
store. `gpt-5.6-luna` at medium reasoning handled responder and internal work;
`gpt-5.6-terra` at high reasoning handled judging.

| Metric | Full-run value |
|---|---:|
| `contains_answer` | 0.4900 |
| F1 | 0.5551 |
| `judge_accuracy` / `llm_judge` | 0.7620 |
| `search_hits` | 8.5380 |

The staged dataset version is `longmemeval-oracle`, payload SHA-256
`821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c`.
The public
[frontier artifact](./benchmarks/results/2026-07-17-longmemeval-gpt-5.6-luna-810f36a.json)
contains only task ids and scores, while the
[sanitized Build Week receipt](./benchmarks/evidence/2026-07-17-longmemeval-gpt-5.6-luna-build-week-receipt.json)
binds the private result and manifest without publishing questions, answers,
recall text, paths, or ledger state. The receipt records 2,892 calls,
50,212,877 estimated input-plus-output tokens, 745.745695 locally estimated
budget units, and zero Sol calls. Usage and budget-unit totals are local
instrumentation estimates, not account billing. This is one uncalibrated,
model-judged run and does not establish run-to-run variance or cross-system
superiority.

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

### Historical Opus full-run estimate (not executed)

Based on the measured per-task wall times (965 s / 100 = ~9.7 s locomo,
580 s / 50 = ~11.6 s longmemeval — wall time includes ingestion, recall,
responder, and judge; mean responder query latency alone was 7.5 s / 9.6 s):

| Run | Tasks | Estimated wall time |
|---|---|---|
| LoCoMo full | 1986 | ~5.3 h |
| LongMemEval full | 500 | ~1.6 h |
| **Total** | **2486** | **~6.9 h** |

This Opus-via-Claude-Code estimate fits an 8-hour budget but would consume a
significant fraction of the operator's weekly Claude Max Opus quota. It is
separate from the completed GPT-5.6 Codex CLI LongMemEval run above. A full
Opus pass or raw-API result remains an explicitly authorized follow-up, not a
missing prerequisite for the Build Week evidence.

### Build Week Codex CLI credit protocol

The Build Week GPT-5.6 run is a separate frontier provenance path from both
Opus via Claude Code and the OpenAI Responses API. Codex CLI model slugs must
be recorded exactly: `gpt-5.6-luna` handles bulk responder and Remnic-internal
work, while `gpt-5.6-terra` handles quality-critical judging. The exact
Responses API model id `gpt-5.6` is an optional API judge, not an alias for
either CLI model. Check the authenticated catalog immediately before a run
with `codex debug models`. `gpt-5.6-sol` is disabled for the bounded plan and
requires an explicit operator opt-in.

The Build Week grant starts with 2,473 Codex credits. Run the benchmark as the
only Codex user on the account: the CLI does not expose a machine-readable
account balance, while this ledger can only observe calls made by this harness.
Bounded mode verifies that `codex login status` reports ChatGPT authentication.
A 473-credit in-flight
safety reserve leaves a hard planned-spend ceiling of 2,000 credits. Runs use
normal service, not fast mode. The provider adds actual usage from every
`turn.completed` JSONL event to an atomic JSON ledger before the next batch is
sized. The reserve absorbs only the possible overshoot from a completion whose
cost cannot be known before it returns; no new call starts after planned spend
reaches 2,000 credits.

| CLI model | Planned role | Input / 1M | Cached input / 1M | Output / 1M |
| --- | --- | ---: | ---: | ---: |
| `gpt-5.6-luna` | Responder and internal work | 25 | 2.5 | 150 |
| `gpt-5.6-terra` | Judge | 62.5 | 6.25 | 375 |

For one completed turn, charge
`((input_tokens - cached_input_tokens) * input_rate + cached_input_tokens * cached_rate + output_tokens * output_rate) / 1,000,000`.
For exclusive harness use, the local ledger invariant is `spent + remaining =
2,473`. Dispatch stops at
2,000 spent; a just-completed call may consume part of the reserve, but total
spend may never exceed 2,473. Estimates do not replace the completed-turn
record. A missing terminal usage event blocks the ledger until manual account
reconciliation instead of permitting another charged call.

Each provider call is a one-shot, non-interactive `codex exec` launched in a
new empty temporary workspace. It ignores user configuration and repository
rules, disables hooks, and keeps no session. The sandbox is read-only,
approvals are denied, and the benchmark prompt instructs the model not to use
tools. Artifacts must record this isolation and the selected provider/model
for each role.

Configure the guard and run a measured smoke before selecting a task count:

```bash
export BUILD_WEEK_RUN_ROOT="$HOME/.remnic/bench/build-week-2026"
export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"
umask 077
mkdir -p "$BUILD_WEEK_RUN_ROOT" "$BUILD_WEEK_RESULTS_DIR"
chmod 700 "$BUILD_WEEK_RUN_ROOT" "$BUILD_WEEK_RESULTS_DIR"

export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473
export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473
export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"

remnic bench run longmemeval \
  --runtime-profile real \
  --limit 1 \
  --dataset-dir ./bench-datasets/longmemeval \
  --results-dir "$BUILD_WEEK_RESULTS_DIR" \
  --drain-timeout 600000 \
  --system-provider codex-cli --system-model gpt-5.6-luna \
  --system-codex-reasoning-effort medium \
  --internal-provider codex-cli --internal-model gpt-5.6-luna \
  --internal-codex-reasoning-effort medium \
  --judge-provider codex-cli --judge-model gpt-5.6-terra \
  --judge-codex-reasoning-effort high

# Replace this only after the smoke ledger establishes observed cost.
remnic bench run longmemeval \
  --runtime-profile real --limit <LEDGER_DERIVED_LIMIT> \
  --dataset-dir ./bench-datasets/longmemeval \
  --results-dir "$BUILD_WEEK_RESULTS_DIR" \
  --drain-timeout 600000 \
  --system-provider codex-cli --system-model gpt-5.6-luna \
  --system-codex-reasoning-effort medium \
  --internal-provider codex-cli --internal-model gpt-5.6-luna \
  --internal-codex-reasoning-effort medium \
  --judge-provider codex-cli --judge-model gpt-5.6-terra \
  --judge-codex-reasoning-effort high
```

`--limit` caps loaded items. `--trial-limit` caps scored trials only for LoCoMo
and MemoryAgentBench. Neither flag is a token-credit budget, so the placeholder
cannot be replaced with a fixed universal value: derive it from the ledger's
observed per-task cost and resize after each bounded batch. A limited run is a
trial artifact and cannot be promoted as a full leaderboard result.
The measured probe is a full-mode run bounded to one staged LongMemEval item.
Full mode fails before provider dispatch if the explicit dataset directory is
missing or unreadable; it cannot fall back to the bundled quick fixture. The
larger bounded command uses the same gitignored source, and neither command
auto-selects the CLI-managed dataset store.

The Codex CLI profile supplies a 180-second transport-only timeout by default.
Do not add `--request-timeout` to this protocol: an explicit request timeout
also becomes a whole benchmark-phase guard and can prematurely cap a long
store, recall, or reset phase. Keep the independent 600-second drain timeout
for queued internal work.

Keep both the atomic ledger and stored results outside the checkout: results
may contain questions, answers, and recalled context. The restrictive `umask`
and explicit directory modes above protect new files; after the ledger is
created, enforce `chmod 600 "$REMNIC_BENCH_CODEX_CREDIT_LEDGER"`. Preserve the
exact run ID printed by the CLI, or recover it from only this store with
`remnic bench runs list --results-dir "$BUILD_WEEK_RESULTS_DIR"`. Use that ID
for export and promotion rather than selecting an ambiguous latest result.

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
  --local-lab-manifest docs/benchmarks/configs/local-lab-3090.json \
  --judge-provider claude-cli --judge-model opus \
  --results-dir ~/.remnic/bench/results \
  --calibration-dir ~/.remnic/bench/build-week-2026/calibration \
  --source-result-id 6e499698-6eaf-4a06-8a81-3d90dd867e57 \
  --expected-answer-set-sha256 a360907a60753d56bd066de88eb903464f1cb4f8fef89a930dd6a5f728f3ad81 \
  --expected-question-id-list-sha256 9a603e17ed3c0eae426243364e6a98b5b4932bfe723ed3332408b825b9860869 \
  --local-judge-request-timeout 180000 \
  --frontier-judge-request-timeout 600000
```

For the pinned Build Week LongMemEval source, use the same command with
`--benchmark longmemeval`, source id
`a7ab6f70-5661-499e-b4b2-99bf0830368c`, answer-set hash
`009e69a367b0d048f7db18bf51cde91b690a7520ce7246cee6f35ab9c5ca02e4`,
and ordered-question-id hash
`9778429495a91bb01db6899743d4476c0a4f1848789fce175ef2df90d100e3f5`.

This scores a deterministic, pinned 200-question calibration slice with both
the local and frontier judges (or every available question when fewer than
200 exist) and reports **Cohen's kappa** with a deterministic paired-bootstrap
95% confidence interval. The exact stored-result source, ordered question IDs,
and answer-set hash are pinned so later calibration runs cannot silently switch
answer payloads. Each successful judge side is atomically checkpointed, so an
interrupted run resumes without repaying completed calls. The checkpoint is
bound to the source bytes, ordered IDs, slice, each provider's actual prompt
identity, the category-binning identity, and both sanitized judge configurations.
An exclusive 0600 lock covers initialization, every paid-call reservation, and
each atomic update; concurrent or stale locks fail safe rather than risking a
duplicate call. Corrupt or mismatched state fails before model calls. The kappa
and provenance are persisted in the exact `--calibration-dir` and land in a
subsequent Tier L artifact only when that run supplies the same directory plus
the `localJudgeConfigHash` and `frontierJudgeConfigHash` printed by
`judge-calibrate --json`:

```bash
remnic bench run locomo \
  --runtime-profile baseline \
  --judge-provider ollama \
  --judge-model qwen2.5-7b-32k:latest \
  --judge-base-url http://127.0.0.1:11434/api \
  --local-lab-manifest docs/benchmarks/configs/local-lab-3090.json \
  --request-timeout 180000 \
  --calibration-dir ~/.remnic/bench/build-week-2026/calibration \
  --calibration-local-config-sha256 <localJudgeConfigHash> \
  --calibration-frontier-config-sha256 <frontierJudgeConfigHash>
  # ...the same local judge identity and normal run flags
```
The sibling `scripts/bench/run-tierf-opus.sh` and
`scripts/bench/run-tierf-opus-real.sh` wrappers use that same calibration
directory for calibration, preflight, and attachment. Set
`TIERF_CALIBRATION_DIR` on both invocations to override it. The real-profile
wrapper reads both persisted configuration hashes and passes the directory,
hashes, manifest, and request timeout to each full run; the CLI fails before
benchmark dispatch when any binding is missing or stale.


For a non-`local-lab` responder profile, `--local-lab-manifest` binds only the
judge. The CLI judge provider/model/base URL remain explicit assertions against
the normalized manifest identity, while temperature, seed, and the runtime
timeout, 429-wait, and disable-thinking overlays come from the shared resolver
used by `judge-calibrate`. If a later run supplies `--max-429-wait` or
`--disable-thinking`, supply the identical flag/value to `judge-calibrate` so
the persisted and runtime local-judge configuration hashes remain identical.
During calibration those two shared transport/model overlays apply to both the
local and frontier judge calls. The attachment path fails before dispatch if
either surface drifts.

The attached artifact records
`judgeCalibration`, including `kappa`, `sampleSize`, `threshold`, `warning`,
`confidenceInterval`, `bootstrapSamples`, `sourceResultId`, `answerSetHash`,
`sliceQuestionIds`, and both configuration hashes.
`judge-calibrate` deliberately uses this dedicated checkpoint rather than the
general `--judge-cache-dir`: resumed outputs are reported separately from fresh
judge calls and are never mislabeled as ordinary cache hits.
`judge-calibrate` currently measures the default scalar judge prompt. Therefore
AMA-Bench runs using `--ama-bench-judge-protocol recommended` do not attach that
κ; supplying calibration pins to such a run fails before model dispatch rather
than stamping default-prompt agreement onto a binary-protocol artifact.
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

## Cue recall and leaderboard safety

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

### Build Week GPT-5.6 full MemCorrect (2026-07-17)

Source head `810f36ae`, Remnic 9.7.6, completed 40/40 scenarios with zero task
failures using the `real` Remnic-native adapter and fresh isolated stores.
The generated corpus is pinned as `memcorrect-v1-c077e7`, payload SHA-256
`ebbb5889561188354171d3f1323b1284e6c6dc36e40d5fd5cf718ec722401acb`.
Luna at medium reasoning handled system and internal work; Terra at high
reasoning judged correction acceptance and stale harm.

| Metric | Full-run value | Reading |
|---|---:|---|
| `uptake_at_next` | 0 | No deterministic next-turn uptake |
| `uptake_latency` | 8 | All 40 observations censored |
| `non_resurrection` | 0 | Stale content resurfaced |
| `false_apply` | 1 | Deterministic containment floor |
| `scope_precision` | 0 | Deterministic containment floor |
| `reassertion` | 1 | Reassertion probe passed |
| `judge_correction_acceptance` | 0.9875 | Terra model judgment |
| `judge_stale_harm_avoidance` | 1 | Terra model judgment |

The high judge scores do not override the deterministic failures. Their sharp
divergence is a benchmark finding and must not be described as a strong or
successful MemCorrect result. The
[sanitized receipt](./benchmarks/evidence/2026-07-17-memcorrect-v1-gpt-5.6-luna-build-week-receipt.json)
records 550 calls, 8,355,708 estimated input-plus-output tokens, 98.720145
locally estimated budget units, and zero Sol calls. It reports a single run;
its model-judged and accounting values carry evaluator-variance and
local-estimate limitations. The 25,056-byte self-contained report remains
private because it contains task detail; its SHA-256 is
`006509082e20d67bb948bd461cb5825a8c0268bade67247c59c63d17efe53792`.

## Ethics

- No dataset file or raw LLM trace is committed to this repo.
- No API key, credential, or private profile appears in any artifact.
- Artifact contents are validated by `parseBenchmarkArtifact()` before
  serialization; anything that fails the schema is rejected at build
  time, not silently elided.
