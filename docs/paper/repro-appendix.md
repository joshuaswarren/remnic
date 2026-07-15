# Appendix A: Reproducibility

> **Scope.** This appendix is the proof that every number in §6 is independently
> reproducible on one GPU (an NVIDIA RTX 3090, 24 GB). It documents the two
> artifacts that pin a run — the **benchmark repro-manifest** (`MANIFEST.json`)
> and the **model-lab manifest** — and gives the exact commands to reproduce a
> Tier L (local) or Tier F (frontier) run end to end. It is the operational
> realisation of the publishability rubric in §5 (non-mock; repro manifest
> present; judge calibration reported; honest framing attached; leaderboard-safe;
> reproducible on one GPU).
>
> **Honesty boundary.** Every command and schema below traces to committed
> code or docs, with one exception marked pending where it appears: the
> trained faithfulness-gate v1 weights manifest (§A.4.3, #1737). The Tier L
> anchor artifacts, the MemCorrect full-matrix artifacts, and the Tier F
> frontier artifacts on `main` (§A.1.2) are cited as committed evidence;
> this appendix never describes an un-run experiment as if it were done.

---

## A.1 The two pinning artifacts

A reproducible Remnic benchmark run is locked by **two** artifacts.
They are distinct and serve distinct roles: the repro-manifest is generated
automatically beside every run (not committed to git — it accompanies the
operator's result store), while the result artifact is the one promoted
into `docs/benchmarks/results/` per release.

| Artifact | Format | Lives at | Pins |
| --- | --- | --- | --- |
| **Benchmark repro-manifest** | `MANIFEST.json` (JSON, schema v1) | Beside the result files in the results directory | result hashes, dataset file hashes, seed, runtime profile, command argv (secrets redacted), git state, environment, QMD collections, config-file hashes |
| **Benchmark result artifact** | `<date>-<benchmark>-<model>-<sha>.json` (JSON, schema v1) | `docs/benchmarks/results/` (gitignored; promoted per-release) | benchmark id, dataset version, system + model + seed, aggregate + per-task metrics, tier, hardware envelope, judge calibration |

A third artifact — the **model-lab manifest** — pins the small classifier
models the extraction pipeline consumes (faithfulness gate, correction-intent
detector). It is described in §A.4.

### A.1.1 Benchmark repro-manifest (`MANIFEST.json`)

**Source:** `packages/bench/src/repro-manifest.ts` (exported via
`@remnic/bench`; written automatically beside every package-backed
`remnic bench run`).

Every `remnic bench run *` that uses the package-backed bench module writes a
`MANIFEST.json` beside the result files. The manifest is the tamper-evident
lock on the run: it records everything an independent operator needs to
re-detect drift, and an `artifactHash` that changes if any pinned field changes.

**Schema (v1)** — the top-level shape (field names are stable; see
`BenchmarkReproManifest` in `repro-manifest.ts` for the authoritative
definition):

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-07T12:00:00.000Z",
  "run": {
    "id": "<run-id>",
    "mode": "full",                       // "full" | "quick"
    "selectedBenchmarks": ["locomo"],
    "runtimeProfiles": ["local-lab"],
    "selectedWorkItems": [
      { "benchmark": "locomo", "runtimeProfile": "local-lab" }
    ],
    "limit": null,                        // present only if --limit was passed
    "seed": 1573
  },
  "git": {
    "commit": "<full-sha>",
    "shortCommit": "<short-sha>",
    "dirty": false,                       // true if uncommitted changes at run time
    "dirtyEntryCount": 0
  },
  "command": {
    "cwd": "/path/to/remnic",
    "argv": [ "bench", "run", "locomo", "--runtime-profile", "local-lab", "..." ],
    "envKeys": [ "PATH", "HOME", "NODE_OPTIONS" ]   // names only; never values
  },
  "environment": {
    "platform": "linux",
    "arch": "x64",
    "nodeVersion": "v22.12.0",
    "hostname": "jarvis-ml",
    "packageManager": "pnpm@10"
  },
  "qmd": {                                // present when QMD collections are in play
    "configDir": "/home/op/.remnic/qmd",
    "cacheDir": "/home/op/.remnic/qmd/cache",
    "collections": ["default"]
  },
  "configFiles": [                        // hashes of config files passed to the run
    { "label": "remnic", "path": "/.../remnic.json", "sha256": "…", "sizeBytes": 4096 }
  ],
  "datasets": [
    {
      "benchmark": "locomo",
      "status": "hashed",                 // "hashed" | "not-provided" | "missing"
      "path": "/.../bench-datasets/locomo",
      "realpath": "/.../bench-datasets/locomo",
      "fileCount": 1,
      "totalBytes": 1048576,
      "sha256": "…",                      // hash over the dataset file set
      "files": [
        { "path": "locomo10.json", "kind": "file", "sizeBytes": 1048576, "sha256": "…" }
      ]
    }
  ],
  "results": [
    {
      "path": "2026-07-07-locomo-…-47aae03.json",
      "sha256": "…",
      "sizeBytes": 8192,
      "resultId": "<run-id>",
      "benchmark": "locomo",
      "mode": "full",
      "gitSha": "47aae03",
      "runCount": 1,
      "seeds": [1573],
      "taskCount": 1986,
      "configHash": "…"
    }
  ],
  "artifactHash": "…"                      // deterministic hash over the manifest body
}
```

**Secret safety.** The argv sanitizer (`sanitizeArgv` in `repro-manifest.ts`)
redacts every known secret flag (`--api-key`, `--token`, `--auth-token`,
`-k`, `-p`, `-t`, `--system-api-key`, `--judge-api-key`, …) and any
assignment whose key matches the secret-key pattern
(`api[-_]?key`, `secret`, `password`, `credential`, `*token`, …). Redacted
values are replaced with the literal `[redacted]`. Only the **names** of
environment variables are recorded (`envKeys`), never their values. This is
why the manifest is safe to commit alongside a public result.

**How to read it.** An independent operator reproduces a run by:
1. Checking out the pinned `git.commit`.
2. Placing the dataset files so their hashes match `datasets[].files[].sha256`.
3. Re-issuing the CLI binary plus `command.argv` — e.g.
   `remnic <command.argv>` (the manifest records `process.argv.slice(2)`, so the
   `remnic` binary itself is omitted), substituting their own endpoint URLs / keys.
4. Re-running and comparing metrics + per-task scores. **Do not expect
   byte-identical `results[].sha256`** — that hash covers the entire stored
   `BenchmarkResult` file, including run-local metadata (`meta.timestamp`,
   latency totals), so it differs even at temperature 0. Instead, verify the
   dataset/config pins match (`datasets[].sha256`, `git.commit`) and the
   reproduced metrics fall within the expected variance band.

### A.1.2 Benchmark result artifact

**Source:** `packages/bench/src/published-artifact.ts`
(`BenchmarkArtifact`, schema v1).

One artifact JSON is written per run to
`docs/benchmarks/results/<iso-date>-<benchmark>-<model>-<gitShaShort>.json`.
The directory is gitignored during development; specific artifacts are
promoted with `git add -f` per the runbook (§6 of `docs/benchmarks/runbook.md`).

**Tier values.** `BenchmarkArtifactTier` is `"local" | "frontier"` only.
`parseBenchmarkArtifact()` rejects any other value. Tier L (local-lab
regression) records `tier: "local"` plus a `hardware` envelope; Tier F
(leaderboard) records `tier: "frontier"`. Older artifacts omit `tier`
(absence is treated as frontier for backwards compatibility).

**Judge calibration.** `judgeCalibration` carries the Cohen's κ between the
local and frontier judges over a deterministic, pinned 200-question slice (or
all available questions when fewer than 200 exist), plus a deterministic
paired-bootstrap 95% confidence interval, sample size, threshold, and a
`warning` flag set when κ falls below threshold. The stored-result source,
ordered question IDs, and answer-set hash pin the judged payload across reruns.
It lands on local artifacts after `remnic bench judge-calibrate` (§A.3.6).

**What is committed today.** `docs/benchmarks/results/` on `main` carries
ten artifacts. Two are clearly-marked mock placeholders
(`2026-04-20-locomo-gpt-4o-mini-mock000.json`,
`2026-04-20-longmemeval-gpt-4o-mini-mock000.json`) with
`datasetVersion: "mock-fixture"` and zeroed metrics — **do not cite**. Two are
the **real Tier L anchors** (`2026-07-07-locomo-qwen2.5-7b-32k_latest-47aae03.json`
and `2026-07-07-longmemeval-qwen2.5-7b-32k_latest-47aae03.json`), both
`tier: "local"`, model `qwen2.5-7b-32k:latest` (Q4_K_M, non-thinking), seed 1,
full dataset (1986/1986 LoCoMo QA; 500/500 LongMemEval-oracle). They predate
the frontier judge pair, so they omit `judgeCalibration` — expected, not a
gap. Two are **bounded Tier F trials** (`2026-07-08-*-798fe8a.json`,
trial-limited) — partial-coverage evidence, never leaderboard numbers. Two
are the **MemCorrect full-matrix** artifacts (`2026-07-13-memcorrect-v1-*-9485f44.json`,
40 scenarios, `mode: full`). Two are the **full Tier F frontier runs**
(`2026-07-14-{locomo,longmemeval}-opus-0676347.json`, Opus 4.8 via Claude
Code, `real` runtime profile, zero task failures), each carrying a stamped
`judgeCalibration` (LongMemEval κ=0.769, `warning: false`; LoCoMo κ=0.135,
`warning: true`). Quote metric values from §6 Results, not here. The trained
faithfulness-gate manifest remains pending — see §A.4.3.

---

## A.2 Hardware envelope

The single-GPU target is an **NVIDIA RTX 3090 (24 GB VRAM, Ampere)**. The
model-size policy below is from `model-lab/README.md` and is the constraint
that shapes every model choice in the local pipeline:

| Operation | RTX 3090 (24 GB, Ampere — bf16 yes, FP8 no) |
| --- | --- |
| Encoder classifier fine-tune (DeBERTa-v3-large class, ~0.4 B) | Trivial: full fine-tune, minutes–1 h |
| Full fine-tune, causal LM | ≤ ~1.5 B comfortably |
| LoRA (bf16 base) | ≤ ~8 B |
| QLoRA (4-bit base + paged optimizer) | ≤ ~14 B (bs 1–2 + grad-accum); ~30 B-class technically possible but too slow to iterate — out of policy |
| Inference serving (Ollama / vLLM, 4-bit) | ~14 B dense or ~30 B-class MoE, one model at a time |

**Policy: target models ≤ 4 B for the two classifier tasks** (faithfulness
gate, correction-intent). They are classification, not generation, so small
models + good data win. An 8 B LoRA is an escape hatch if evals demand it;
anything larger needs a written justification in the manifest's
`policyCompliance` block.

The lab box referenced by the model-lab and bench harness is `jarvis-ml`
(Linux, RTX 3090, 256 GB RAM). `macstudio` is the documented failover host
for non-GPU work.

---

## A.3 One-GPU reproduction: Tier L (local) benchmark run

This section reproduces a published-benchmark run (LoCoMo or LongMemEval) on
one RTX 3090, with the responder and judge both served locally. Every command
traces to `docs/benchmarks/runbook.md` or the `remnic bench` CLI help.

### A.3.1 Prerequisites

- **Node.js ≥ 22.12.0** and **pnpm 10+** (full core tests require Node 22:
  `export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"`).
- **Ollama** (or any OpenAI-compatible server: llama.cpp, vLLM, LM Studio)
  serving the responder and judge models on `127.0.0.1`.
- **Dataset access** for the benchmark(s) you plan to run. Some are managed
  via `remnic bench datasets download`; others require manual download (see
  `docs/benchmarks/runbook.md` §2 for the suggested `bench-datasets/` layout).
- A **dedicated benchmark memory directory** — never point a full run at a
  production Remnic memory store.

### A.3.2 One-time setup

```bash
git clone https://github.com/joshuaswarren/remnic.git
cd remnic
pnpm install
pnpm --filter @remnic/core run build
pnpm --filter @remnic/bench run build
pnpm --filter @remnic/cli run build

# `remnic` is exposed as a bin from @remnic/cli. From repo root:
alias remnic='pnpm --filter @remnic/cli exec remnic'

# Inspect available benchmark ids and managed dataset status:
remnic bench list
remnic bench datasets status
```

### A.3.3 Prepare the local models

Pull the responder and judge models into Ollama. The committed profile
(`packages/bench/profiles/local-lab-3090.json`) ships with `PLACEHOLDER-*`
model ids — an operator replaces them with the exact models their endpoint
serves. For the Tier L reproducibility anchor, the intended models are
7B-class instruct models at Q4_K_M:

```bash
# Replace <responder> and <judge> with the exact model ids your endpoint reports.
# The manifest's preflight (A.3.4) will reject a mismatch, listing what the
# endpoint actually serves.
ollama pull <responder>     # e.g. qwen2.5:7b-instruct-q4_K_M
ollama pull <judge>         # same model or a different one
```

> **Gotcha (documented).** Some local models (e.g. qwen3) truncate long
> contexts silently, and Ollama's context-length default is conservative.
> The manifest's `ctx` field declares the serving context. Preflight verifies
> the model id is served, but for Ollama it does **not** verify the reported
> context length (Ollama's `/api/tags` discovery returns only model ids, not
> context sizes), so an operator must confirm the context manually — e.g.
> `OLLAMA_CONTEXT_LENGTH` env var or `ollama show <model> --modelfile` —
> before relying on a large-window run. Pin `ctx` to what your model actually
> supports (the committed profile uses 16384).

### A.3.4 Build the local-lab manifest and preflight

The `local-lab` runtime profile is a JSON manifest — never hardcoded model
strings — that pins responder, judge, and optional embedding to
operator-hosted models. Copy the committed profile and edit the model ids +
base URLs:

```bash
mkdir -p ~/bench
cp packages/bench/profiles/local-lab-3090.json ~/bench/local-lab.json
# Edit ~/bench/local-lab.json:
#   - responder.model / judge.model → your pulled model ids
#   - responder.baseUrl / judge.baseUrl → your endpoint (default 127.0.0.1:11434)
#   - ctx / seed → match your model's real context window; keep seed fixed
```

The manifest shape (from `LocalLabManifest` in
`packages/bench/src/local-lab/manifest.ts`):

```jsonc
{
  "profile": "local-lab",                 // discriminator; must be the literal "local-lab"
  "responder": {
    "provider": "ollama",                 // "ollama" | "openai-compatible"
    "baseUrl": "http://127.0.0.1:11434",
    "model": "<responder>",
    "quantization": "Q4_K_M",            // informational; recorded in artifacts
    "ctx": 16384,                         // manifest-declared serving context (tokens)
    "temperature": 0,                     // pinned to 0 for reproducibility
    "seed": 1573                          // required; reruns reproduce the same draws
  },
  "judge": { /* same shape */ },
  "embedding": { /* optional; same shape */ },
  "phases": "sequential",                 // PR2 ships "sequential" only
  "notes": {
    "responderToJudgeHandoff": "...",     // informational; single-endpoint required today (see below)
    "hardware": { "gpu": "NVIDIA RTX 3090", "vramGb": 24, "ramGb": 256, "ampereBf16Ok": true }
  }
}
```

> **Single-endpoint requirement.** The benchmark runner executes
> recall→answer→judge per trial, which requires responder and judge to be
> co-resident on the **same endpoint** (`responder.baseUrl === judge.baseUrl`).
> Multi-endpoint manifests (separate responder/judge URLs) are rejected at
> preflight — full sequential phase execution (answer-all-then-judge-all with
> an operator swap) is tracked for the PR3 calibration scope. On a single
> 3090, run one `ollama serve` instance and hot-swap models between phases
> (per `packages/bench/profiles/README.md`).

`temperature` must be `0` and `seed` is required — these are validated at
parse time (rule 51: any violation is rejected with the valid kinds listed,
never silently coerced). The runner preflights each role's endpoint before
the benchmark starts: it discovers the live model list and fails fast with
the actual served models on mismatch (so a stale `ollama pull` is caught
before any answering calls).

### A.3.5 Run a Tier L benchmark

```bash
remnic bench run locomo \
  --runtime-profile local-lab \
  --local-lab-manifest ~/bench/local-lab.json \
  --dataset-dir ./bench-datasets/locomo \
  --seed 1
```

> **Seed consistency.** The committed Tier L artifacts (§A.1.2) used
> `seed: 1`. To reproduce them fully, an operator must set the seed in
> **two** places: (a) edit `responder.seed` and `judge.seed` in the
> local-lab manifest to `1` (the committed profile placeholder carries
> `1573`), and (b) pass `--seed 1` on the CLI. The CLI `--seed` flag sets
> the benchmark's reporting seed (item selection + the `seed` field
> serialized into the artifact); the manifest's `role.seed` is forwarded
> into the `ProviderConfig` and sent on each model request (Ollama /
> OpenAI-compatible providers both send `config.seed`). Setting only one
> leaves the artifact seed and the actual sampling seed mismatched. Keep
> the seed fixed across all benchmarks in a comparable suite.

This will: load the full dataset; reset the Remnic orchestrator per item;
ingest the benchmark's memory sessions into the isolated benchmark adapter;
recall + answer each question with the pinned responder; score via the pinned
local judge; and write a `BenchmarkResult` JSON + `MANIFEST.json` under the
default results store (`~/.remnic/bench/results/`).

To run the full published suite (each benchmark one at a time, per the
runbook):

```bash
for bench in ama-bench memory-arena amemgym longmemeval locomo beam \
             personamem memoryagentbench membench; do
  remnic bench run "$bench" \
    --runtime-profile local-lab \
    --local-lab-manifest ~/bench/local-lab.json \
    --dataset-dir "./bench-datasets/$bench" \
    --seed 1
done
```

### A.3.6 Cross-tier judge calibration (Cohen's κ)

The local judge must be calibrated against a frontier gold-standard judge so
a Tier L number is defensible. `remnic bench judge-calibrate` runs both
judges over a benchmark's cached answers, reports Cohen's κ, and persists it
so subsequent local artifacts carry the κ + warning in `judgeCalibration`:

```bash
remnic bench judge-calibrate \
  --benchmark locomo \
  --local-lab-manifest ~/bench/local-lab.json \
  --judge-provider <frontier-provider> \
  --judge-model <frontier-judge-model> \
  --results-dir ~/.remnic/bench/results \
  --calibration-dir ~/.remnic/bench/calibration \
  --source-result-id <exact-full-result-id> \
  --expected-answer-set-sha256 <sha256> \
  --expected-question-id-list-sha256 <sha256> \
  --local-judge-request-timeout 180000 \
  --frontier-judge-request-timeout 600000
```

The κ lands on the next `remnic bench run` artifact for that benchmark
(only when the run's judge matches the calibrated pair). Absent calibration
is the common case — the result is written unchanged. The command selects a
deterministic 200-question slice (or all available questions when fewer than
200 exist), pins the source result, question IDs, and exact answer-set hash,
and reports a deterministic 2,000-resample paired-bootstrap 95% confidence
interval. Re-running calibration reuses the pinned answer payload instead of
silently selecting whichever stored answers are newest. An atomic 0600
checkpoint records each completed judge side and resumes only missing calls;
its complete source/slice/rubric/judge contract must match or the command fails
closed before either judge runs.

### A.3.7 Build, verify, and promote the artifact

`remnic bench run` (§A.3.5) writes a stored `BenchmarkResult` (full
meta/config/cost/per-task) under the results store
(`~/.remnic/bench/results/`). The publishable `BenchmarkArtifact` (flat
metrics + per-task scores + reproducibility envelope) is produced from it by
the bridge script `scripts/bench/build-artifact-from-result.ts`. This
two-step split keeps the heavy stored run separate from the lean published
shape.

```bash
# 1. Promote the stored result into a publishable BenchmarkArtifact.
#    --tier local requires the full hardware envelope (--gpu, --vram-gb,
#    --quantization); the script exits non-zero if any is missing.
#    --dataset-version is benchmark-specific: locomo-10 for LoCoMo,
#    longmemeval-oracle for LongMemEval (see build-artifact-from-result.ts
#    defaults).
pnpm exec tsx scripts/bench/build-artifact-from-result.ts \
  ~/.remnic/bench/results/<your-result>.json \
  docs/benchmarks/results \
  --tier local \
  --gpu "NVIDIA RTX 3090" \
  --vram-gb 24 \
  --quantization Q4_K_M \
  --dataset-version <locomo-10|longmemeval-oracle> \
  --note "Tier L full run; responder+judge = <model> Q4_K_M (non-thinking)"

# 2. Validate + re-hash the produced artifact; exits non-zero on mismatch:
pnpm exec tsx scripts/bench/verify-artifact.ts \
  docs/benchmarks/results/<your-artifact>.json

# 3. Inspect the reproducibility lock for the last run set:
jq . ~/.remnic/bench/results/MANIFEST.json
```

> **Calibration ordering.** `judge-calibrate` (§A.3.6) persists κ *after* the
> run, so the `BenchmarkResult` from §A.3.5 does not carry it yet. The κ is
> attached on the **next** `remnic bench run` that uses the same judge pair.
> To produce an artifact with `judgeCalibration` populated, calibrate first,
> then re-run the benchmark, then promote that second result. The two Tier L
> anchor artifacts on `main` were produced before any frontier judge was
> available, so they omit `judgeCalibration` — expected, not a gap. The two
> full Tier F artifacts (`2026-07-14-*-opus-0676347.json`) followed the
> calibrate-first ordering and carry it.

The build script rejects partial and quick-mode runs and runs that record a
`config.benchmarkOptions.limit` / `trialLimit` (issue #1712 publish-safety
guards). Note: a top-level CLI `--limit` that lands outside
`benchmarkOptions` is not currently caught by this check — verify manually
that no `--limit` was used before promoting a full-mode run.

To promote a specific artifact to the public results directory (which is
gitignored by default), use `git add -f` on exactly the file(s) you intend
to publish — never `git add docs/benchmarks/results/`.

---

## A.4 One-GPU reproduction: model-lab (faithfulness gate)

The extraction pipeline consumes two small classifiers — the **faithfulness
gate** (#1576 / #1585) and the **correction-intent** detector (#1581 / #1585).
Both are reproduced from a committed manifest; **no datasets or weights are
ever committed** (git carries recipes and hashes, never blobs). The
model-lab is a standalone Python tree (3.12+, typed), not an npm workspace;
the only CI hook is the seeded data generator's determinism test.

**Source:** `model-lab/README.md`, `model-lab/faithfulness-gate/manifest.json`,
`model-lab/common/jsonl_schema.py`.

### A.4.1 The model-lab manifest

The manifest is the **only** committed artifact for a trained model. Its
shape (from `model-lab/faithfulness-gate/manifest.json`):

```jsonc
{
  "task": "faithfulness-gate",
  "schemaVersion": 1,
  "status": "pending-training",           // "pending-training" | "trained"
  "contract": {
    "inputFields": ["factText", "quote", "context"],
    "outputLabels": ["entailed", "contradicted", "unsupported"],
    "source": "FaithfulnessCheckInput (issue #1576)"
  },
  "baseModel": null,                       // filled at training (e.g. roberta-large-mnli)
  "dataRecipe": {
    "generatorPath": "model-lab/faithfulness-gate/generate-data.py",
    "generatorGitSha": null,              // pins the recipe commit that produced the dataset
    "seed": 1337,
    "sources": ["synthetic-perturbation"],
    "counts": { "entailed": null, "contradicted": null, "unsupported": null, "total": null },
    "datasetSha256": null                 // the authoritative reproducibility pin
  },
  "hyperparams": null,                     // filled at training
  "trainedAt": null,
  "hardware": null,                        // filled at training (GPU, precision, wall-time)
  "eval": {
    "heldOut": null,                       // macro/per-class F1 — filled after eval.py
    "downstream": null                     // gate quality vs prompted-LLM baseline (#1574 ablation)
  },
  "artifact": {
    "hfRepo": null,                        // HF Hub upload target
    "revision": null,                      // integrity pin (localArtifactSha256 until HF upload)
    "quantizations": null
  },
  "policyCompliance": {
    "targetMaxParamsB": 4,                 // issue #1585 policy
    "actualParamsB": null,
    "escapeHatchUsed": false
  }
}
```

**Reproducibility model.** Re-running `generate-data.py --seed <s>` must
reproduce `datasetSha256`; the manifest records it so a future operator can
verify the dataset they regenerated matches the one a model was trained on.
The determinism contract (same seed → byte-identical dataset → identical
sha256) is asserted by `tests/model-lab-faithfulness-data.test.mjs`, which
shells out to `generate-data.py` and is capability-guarded on `python3`
(skip-with-reason locally; `REMNIC_REQUIRE_CAPABILITY_TESTS=1` forbids
skipping in CI).

**State on `main` today.** The committed manifest ships as the **schema
example** with every eval/weight field explicitly `null` / `pending` (rule
55: no fabricated numbers). The trained v1 (held-out macro-F1, base model
`roberta-large-mnli`, 204-record dataset, deterministic sha256) is produced
by PR #1737 and is **pending merge** as of this writing — the numbers below
describe the v1 *target* and are marked `[pending #1737]` until that PR
lands and fills the manifest's `eval` block on `main`.

### A.4.2 Reproduce the faithfulness-gate model

```bash
# ── CI / data generation (no GPU, no pip install) ──────────────────────
# Self-test every perturbation against hand-written cases:
python model-lab/faithfulness-gate/generate-data.py --selfcheck

# Generate a seeded dataset (same seed → same sha256):
python model-lab/faithfulness-gate/generate-data.py --seed 1337 --out /tmp/faith --yes
# → DATASET_SHA256=<hex>  (stdout, machine-parseable)

# ── Lab box (GPU + deps) ───────────────────────────────────────────────
bash model-lab/setup.sh
source model-lab/.venv/bin/activate

python model-lab/faithfulness-gate/generate-data.py --seed 1337 --yes   # → faithfulness-gate/data/
python model-lab/faithfulness-gate/train.py   --version-tag v1 --base-model roberta-large-mnli  # → model-lab/runs/faithfulness-gate/v1/
python model-lab/faithfulness-gate/eval.py    --version-tag v1          # → manifest eval block
```

`train.py` / `eval.py` lazy-import the GPU stack so `--help` works on a bare
machine; the training entry point exits with code 2 and an install hint if
`torch` / `transformers` are missing. **They never run in CI.**

### A.4.3 v1 target (pending #1737 merge)

| Field | v1 target `[pending #1737]` |
| --- | --- |
| Held-out macro-F1 | 1.000 (per-class all 1.0; 21-example 10 % split) — clears the #1585 ≥ 0.9 target |
| Held-out p95 latency | 9.93 ms (single-example GPU forward, fp32) |
| Base model | `roberta-large-mnli` (0.355 B, ≤ 4 B policy) |
| Dataset | 204 records, 1:1:1 balanced, deterministic sha256 `751aa45d…` |

> **Honest caveat (from #1737).** The held-out split is drawn from the same
> systematic perturbation generator as the train set, so the macro-F1
> reflects perfect separation of the (code-generated, label-trustworthy)
> perturbation patterns, not real-world robustness. The number that matters
> for production is the **downstream** one (gate quality vs a prompted-LLM
> baseline), produced by the #1574 bench harness — deliberately an
> `external` dependency in the manifest. RoBERTa-MNLI is the documented
> ≤ 4 B fallback because DeBERTa-v3 (base and large) NaNs in fp32 on this
> box (XPOS relative-position overflow in the backward pass) and is
> numerically unstable under bf16 on small data.

---

## A.5 Tier F (frontier) reproduction

### A.5.1 Opus via Claude Code

The Tier F responder is **Opus 4.8 via Claude Code (`claude -p`)**, through
the `claude-cli` bench provider. This is a valid research harness and a
distinct provenance path from the raw Anthropic API; the benchmark artifact
records the provider, model, harness, isolation settings, and invocation
configuration. The Tier F run (#1728) uses the same supported artifact schema
as other frontier runs.

**Provenance labelling.** A `claude -p` result is labeled "Opus 4.8 via Claude
Code" and retains `tier: "frontier"` when it satisfies the Tier-F artifact
contract. Claude Code entitlement and model-alias details are part of the
measurement provenance, not grounds for downgrading the result. Raw API and
Claude Code runs are distinct measurement paths; neither is inherently the
valid one. The artifact carries the harness label in its `note` and model
metadata (for example, `opus-4-8-via-claude-code`). No new tier value is
invented — `BenchmarkArtifactTier` is `"local" | "frontier"` only and
`parseBenchmarkArtifact()` rejects anything else.

**Isolation (mandatory).** The `claude-cli` provider (PR #1735) runs
`claude -p` from a freshly-created empty temp workspace with `--tools ""`
(the flag that actually disables built-in tools), `--safe-mode` (Claude
Code's config-skipping equivalent of Codex's `--ignore-user-config`), and
`--system-prompt` for the scoring protocol. Without these it inherits
`~/.claude/CLAUDE.md` / project settings and silently contaminates every
answer.

**Fitting Claude Max x20 session limits.** A full run (~1986 LoCoMo + 500
LongMemEval ≈ 2486 responder calls, ×2 if the judge is also Opus) exceeds
the 5-hour / weekly caps. The protocol:

1. **Judge on the local 3090, not Opus** — halves the `claude -p` load;
   calibrate the local judge against a small Opus-judged sample (Cohen's κ,
   §A.3.6) so it stays defensible.
2. **Checkpoint + resume** — persist each completed item's result and skip
   it on restart; `results-store.ts` / `repro-manifest.ts` are the building
   blocks, but a resumable per-item runner is a prerequisite to implement
   before relying on multi-window resume.
3. **Low concurrency + usage-limit backoff** — concurrency 1; detect the
   usage-limit message, sleep until the window resets, resume (built into
   the `claude-cli` adapter).
4. **Sample first** — a stratified 200–300-item pass is a **pilot**
   (method + pipeline validation), **not** a publishable leaderboard number;
   scale to the full set before any number is published.
5. **Judge cache** — never re-judge an identical answer (already in the
   harness).

### A.5.2 GPT-5.6 via Codex CLI with a credit ledger

The Build Week GPT-5.6 run is a second CLI-backed Tier F path. It must retain
the exact Codex CLI model slugs and must not be relabeled as a raw API run:

- `gpt-5.6-luna`: bulk responder and Remnic-internal work.
- `gpt-5.6-terra`: quality-critical judging.
- `gpt-5.6-sol`: explicit opt-in only; disabled for the bounded plan.
- `gpt-5.6`: the distinct Responses API model id for the optional API judge.

Run `codex debug models` immediately before the benchmark and retain its model
catalog result with the operator receipt. The harness starts a new
non-interactive `codex exec` for each completion in a fresh empty temporary
workspace. It ignores user config and project rules, disables hooks, and keeps
no session. It uses a read-only sandbox with approvals denied, and its
benchmark prompt instructs the model not to use tools. The harness passes the
prompt on stdin, captures only the final response, and removes the workspace.
This is one-shot isolation per completion, not one shared chat session per
benchmark.

The Build Week grant is 2,473 Codex credits. Keep the account exclusive to this
single harness process during the run because Codex CLI has no machine-readable
account-balance command. Bounded mode requires `codex login status` to report
ChatGPT authentication. Keep 473 credits as an in-flight
safety reserve and allow no more than 2,000 credits of planned spend. Use
normal service, not fast mode. Configure the provider's guard before the first
turn:

```bash
export BUILD_WEEK_RUN_ROOT="$HOME/.remnic/bench/build-week-2026"
export BUILD_WEEK_RESULTS_DIR="$BUILD_WEEK_RUN_ROOT/results"
umask 077
mkdir -p "$BUILD_WEEK_RUN_ROOT" "$BUILD_WEEK_RESULTS_DIR"
chmod 700 "$BUILD_WEEK_RUN_ROOT" "$BUILD_WEEK_RESULTS_DIR"

export REMNIC_BENCH_CODEX_CREDIT_BUDGET=2473
export REMNIC_BENCH_CODEX_CREDIT_RESERVE=473
export REMNIC_BENCH_CODEX_CREDIT_LEDGER="$BUILD_WEEK_RUN_ROOT/codex-credit-ledger.json"
unset REMNIC_BENCH_CODEX_ALLOW_SOL
```

The ledger is an atomic JSON document whose `entries` array grows from Codex
`turn.completed` JSONL events. For each completion, reconcile actual input,
cached-input, and output tokens against these rates (credits per one million
tokens):

| Model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| `gpt-5.6-luna` | 25 | 2.5 | 150 |
| `gpt-5.6-terra` | 62.5 | 6.25 | 375 |

The per-turn charge is
`((input_tokens - cached_input_tokens) * input_rate + cached_input_tokens * cached_rate + output_tokens * output_rate) / 1,000,000`.
With exclusive account use, verify after every batch that the harness ledger's
`spent + remaining = 2,473`. Do not dispatch a
new call after planned spend reaches 2,000; the 473-credit reserve exists to
absorb only the final in-flight call because its actual usage arrives after
completion. Total spend may never exceed 2,473. Because task prompts and
answers vary, do not allocate a fixed trial count in advance. Measure one
quick task, calculate observed credits per task, then set the next workload
bound conservatively. If exact terminal usage is missing, the ledger blocks
further dispatch until manual account reconciliation:

```bash
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

`<LEDGER_DERIVED_LIMIT>` is an operator-computed placeholder, not a missing
token-budget flag. The existing `--limit` caps loaded items, and
`--trial-limit` caps scored trials for LoCoMo or MemoryAgentBench; neither
directly caps credits. The provider environment variables enforce the credit
ceiling, while the ledger determines the next safe task bound. Label every
bounded output as partial coverage and keep the private ledger out of the
public artifact unless it has been sanitized. Stored results may also include
questions, answers, and recalled context, so the external results directory is
private state too. After the first ledger write, enforce
`chmod 600 "$REMNIC_BENCH_CODEX_CREDIT_LEDGER"`. Preserve the exact run ID
printed by the CLI, or recover it only from the isolated store with
`remnic bench runs list --results-dir "$BUILD_WEEK_RESULTS_DIR"`; use that ID
for export and artifact promotion rather than an ambiguous latest run.
The Codex CLI runtime supplies a 180-second transport-only timeout when the
flag is omitted. Do not add `--request-timeout` to these commands: an explicit
value also becomes a whole-phase benchmark guard, which can cut off long
store/recall/reset phases. The 600-second drain timeout is deliberately
separate and remains explicit.

Both commands select the staged, gitignored LongMemEval directory explicitly.
The measured probe uses full mode with `--limit 1`, so a missing or unreadable
dataset fails before provider dispatch instead of falling back to the bundled
quick fixture. The larger bounded command uses the same source. Neither command
can silently auto-select the CLI-managed dataset store.

---

## A.6 Reproduction checklist (maps to the §5 rubric)

| Rubric item | How to verify on a one-GPU reproduction |
| --- | --- |
| Non-mock | The artifact filename's sha segment is not `mock000`; `datasetVersion ≠ "mock-fixture"` |
| Repro manifest present | `MANIFEST.json` exists beside the result; `jq .artifactHash` is non-empty |
| Seed / model / quant / dataset pinned | `run.seed`, `command.argv`, `datasets[].sha256` all match; `responder.{model,quantization,seed}` verified against the local-lab manifest (the manifest is operator-supplied content — hash it separately if you need a committed pin; `ctx` is declared in the manifest but not currently serialized into the artifact) |
| Judge calibration reported | `judgeCalibration.kappa` present on the artifact (after `judge-calibrate`); `warning` considered |
| Honest framing attached | artifact `note` states the tier label honestly (e.g. "Opus 4.8 via Claude Code" for Tier F; "7B local, non-thinking" for Tier L) |
| Leaderboard-safe | explicit-cue-recall guards respected (#841–#850); no hidden gold metadata in the answering path; harness leakage tests pass |
| Reproducible on one GPU | the §A.3 path completes end to end on an RTX 3090 with Ollama-served models |

---

## A.7 Source index

Every command and schema in this appendix traces to a committed source:

| Reference | Source file on `main` |
| --- | --- |
| Repro-manifest schema + sanitizer | `packages/bench/src/repro-manifest.ts` |
| Result artifact schema (tier, hardware, calibration) | `packages/bench/src/published-artifact.ts` |
| Local-lab manifest schema + parser | `packages/bench/src/local-lab/manifest.ts` |
| Local-lab profile (committed placeholder) | `packages/bench/profiles/local-lab-3090.json` |
| Preflight + sequential phases | `packages/bench/src/local-lab/{preflight,sequential-phases}.ts` |
| CLI surface (`--runtime-profile local-lab`, `--local-lab-manifest`, `judge-calibrate`) | `packages/remnic-cli/src/bench-args.ts`, `packages/remnic-cli/src/index.ts` |
| Benchmark runbook (setup, run, verify, publish) | `docs/benchmarks/runbook.md` |
| Result→artifact promotion bridge | `scripts/bench/build-artifact-from-result.ts` |
| Artifact verification | `scripts/bench/verify-artifact.ts` |
| Published-benchmark readiness + leakage guards | `docs/benchmarks/sota-readiness.md` |
| Hardware envelope + model-size policy | `model-lab/README.md` |
| Faithfulness-gate manifest (schema example) | `model-lab/faithfulness-gate/manifest.json` |
| Faithfulness-record contract | `model-lab/common/jsonl_schema.py` |
| Committed artifacts (mocks + Tier L anchors + Tier F trials + MemCorrect + Tier F full) | `docs/benchmarks/results/2026-{04-20,07-07,07-08,07-13,07-14}-*.json` |
