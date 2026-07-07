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
> **Honesty boundary.** Every command and schema below traces to code or docs
> committed on `main` at the time of writing. Where a result is *not yet*
> committed (the trained faithfulness-gate v1 weights, the real Tier L benchmark
> artifacts, the Tier F frontier run), this appendix says so explicitly and
> marks the state — it never describes an un-run experiment as if it were done.

---

## A.1 The two pinning artifacts

A reproducible Remnic benchmark run is locked by **two** committed artifacts.
They are distinct and serve distinct roles:

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
    "argv": [ "remnic", "bench", "run", "locomo", "--runtime-profile", "local-lab", "..." ],
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
3. Re-issuing `command.argv` (substituting their own endpoint URLs / keys).
4. Re-running and confirming the new `results[].sha256` matches (for
   deterministic judges at temperature 0) or falls within the reported
   variance band.

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
local and frontier judges over a fixed calibration slice, plus the sample
size, threshold, and a `warning` flag set when κ falls below threshold. It
lands on local artifacts after `remnic bench judge-calibrate` (§A.3.5).

**What is committed today.** `docs/benchmarks/results/` on `main` carries
four artifacts. Two are clearly-marked mock placeholders
(`2026-04-20-locomo-gpt-4o-mini-mock000.json`,
`2026-04-20-longmemeval-gpt-4o-mini-mock000.json`) with
`datasetVersion: "mock-fixture"` and zeroed metrics — **do not cite**. Two are
**real Tier L artifacts** (`2026-07-07-locomo-qwen2.5-7b-32k_latest-47aae03.json`
for LoCoMo and `2026-07-07-longmemeval-qwen2.5-7b-32k_latest-47aae03.json` for
LongMemEval), both `tier: "local"`, model `qwen2.5-7b-32k:latest` (Q4_K_M,
non-thinking), seed 1, full dataset (1986/1986 LoCoMo QA across all 10
conversations; 500/500 LongMemEval-oracle). They are the reproducibility
anchor the paper skeleton cites — quote their metric values from §6 Results,
not here. Neither carries `judgeCalibration` yet (the local judge has no
frontier pair to calibrate against until the Tier F run lands). The Tier F
frontier artifacts and the trained faithfulness-gate manifest are **not yet
committed** — see §A.4.3 and §A.5 for their pending state.

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
> The manifest's `ctx` field declares the serving context; preflight verifies
> the live endpoint reports at least that much. Pin `ctx` to what your model
> actually supports (the committed profile uses 16384).

### A.3.4 Build the local-lab manifest and preflight

The `local-lab` runtime profile is a JSON manifest — never hardcoded model
strings — that pins responder, judge, and optional embedding to
operator-hosted models. Copy the committed profile and edit the model ids +
base URLs:

```bash
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
    "responderToJudgeHandoff": "...",     // printed between phases if endpoints differ
    "hardware": { "gpu": "NVIDIA RTX 3090", "vramGb": 24, "ramGb": 256, "ampereBf16Ok": true }
  }
}
```

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
  --seed 1573
```

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
    --seed 1573
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
  --results-dir ~/.remnic/bench/results
```

The κ lands on the next `remnic bench run` artifact for that benchmark
(only when the run's judge matches the calibrated pair). Absent calibration
is the common case — the result is written unchanged.

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
pnpm exec tsx scripts/bench/build-artifact-from-result.ts \
  ~/.remnic/bench/results/<your-result>.json \
  docs/benchmarks/results \
  --tier local \
  --gpu "NVIDIA RTX 3090" \
  --vram-gb 24 \
  --quantization Q4_K_M \
  --dataset-version locomo-10 \
  --note "Tier L full run; responder+judge = <model> Q4_K_M (non-thinking)"

# 2. Validate + re-hash the produced artifact; exits non-zero on mismatch:
pnpm exec tsx scripts/bench/verify-artifact.ts \
  docs/benchmarks/results/<your-artifact>.json

# 3. Inspect the reproducibility lock for the last run set:
jq . ~/.remnic/bench/results/MANIFEST.json
```

The build script refuses to promote partial or quick-mode runs, runs with a
`limit`/`trialLimit`, or unpublished benchmark ids — only complete full runs
may be published (issue #1712 publish-safety guards).

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
python model-lab/faithfulness-gate/train.py   --version-tag v1          # → model-lab/runs/faithfulness-gate/v1/
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

The Tier F responder is **Opus 4.8 via Claude Code (`claude -p`)**, through
the `claude-cli` bench provider — not a raw-API frontier call (there is no
API budget). This is a hard dependency on PR #1735 (`claude-cli` provider),
which is **not yet on `main`**; the Tier F run (#1728) is blocked on it.

**Honest labelling.** A `claude -p` number is "Opus 4.8 via Claude Code," not
a raw-API `tier: "frontier"` result. Claude Code adds system-prompt
scaffolding + model-alias routing and is not reproducible without a Claude
Code entitlement. The artifact keeps `tier: "frontier"` (the only supported
value for a non-local run) and carries the label in its `note` + model
metadata (e.g. model `opus-4-8-via-claude-code`). No new tier value is
invented — `BenchmarkArtifactTier` is `"local" | "frontier"` only and
`parseBenchmarkArtifact()` rejects anything else.

**Isolation (mandatory).** The `claude-cli` provider (PR #1735) runs
`claude -p` from a freshly-created empty temp workspace with `--tools ""`
(the flag that actually disables built-in tools), `--safe-mode` (Claude
Code's config-skipping equivalent of Codex's `--ignore-user-config`), and
`--append-system-prompt` for the scoring protocol. Without these it inherits
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

---

## A.6 Reproduction checklist (maps to the §5 rubric)

| Rubric item | How to verify on a one-GPU reproduction |
| --- | --- |
| Non-mock | The artifact filename's sha segment is not `mock000`; `datasetVersion ≠ "mock-fixture"` |
| Repro manifest present | `MANIFEST.json` exists beside the result; `jq .artifactHash` is non-empty |
| Seed / model / quant / ctx / dataset pinned | `run.seed`, `command.argv`, `datasets[].sha256`, and the local-lab manifest's `responder.{model,quantization,ctx,seed}` all match the reproduced run |
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
| Committed artifacts (mock placeholders + real Tier L) | `docs/benchmarks/results/2026-{04-20-mock000,07-07-qwen2.5-7b}*.json` |
