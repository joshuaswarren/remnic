# 2026-04-19 Gemma LM Studio Baseline

## Goal

Measure the current branch against a real local model path, not the lightweight benchmark adapter. The target setup was Remnic running with QMD enabled and a local OpenAI-compatible endpoint from LM Studio, using the Gemma model already loaded on this machine.

This document is an honest baseline of what ran, what passed, and what blocked a true full-suite baseline on 2026-04-19.

## Environment

- Date: `2026-04-19`
- Branch: `codex/openclaw-upgrade-command`
- HEAD: `63b26988`
- Node: `v25.9.0`
- OS: `darwin arm64`
- System model: `google/gemma-4-26b-a4b`
- Judge model: `google/gemma-4-26b-a4b`
- Provider surface: OpenAI-compatible
- Base URL: `http://127.0.0.1:1234/v1`
- Runtime profile: `real`
- Remnic config: `~/.config/remnic/config.json`
- Search backend: `qmd`
- QMD enabled: `true`

LM Studio exposed the model via `GET /v1/models`, and the active Remnic config already pointed local LLM traffic at the same endpoint and model.

## Exact Served Model Identity

The original 2026-04-19 run notes captured the model identifier but not the full LM Studio server metadata. A reproducibility check against the same local LM Studio instance on 2026-04-20 reported the following for the served Gemma model:

- Model ID: `google/gemma-4-26b-a4b`
- Type: `vlm`
- Publisher: `google`
- Architecture: `gemma4`
- Compatibility type: `gguf`
- Quantization: `Q4_K_M`
- Max context length: `262144`

That metadata came from:

```bash
curl -s http://127.0.0.1:1234/api/v0/models/google%2Fgemma-4-26b-a4b | jq .
```

## Safety

These benchmark runs did not write into the operator's live Remnic memory store. The benchmark adapter creates temporary benchmark-specific storage directories, so the runs exercise real retrieval and local-model behavior without polluting the actual memory graph.

## Commands Used

Dataset refresh:

```bash
pnpm exec tsx packages/remnic-cli/src/index.ts bench datasets download --all
```

Verified real-profile quick runs:

```bash
pnpm exec tsx packages/remnic-cli/src/index.ts bench run \
  longmemeval \
  --quick \
  --runtime-profile real \
  --remnic-config ~/.config/remnic/config.json \
  --system-provider openai \
  --system-base-url http://127.0.0.1:1234/v1 \
  --system-model google/gemma-4-26b-a4b \
  --judge-provider openai \
  --judge-base-url http://127.0.0.1:1234/v1 \
  --judge-model google/gemma-4-26b-a4b
```

```bash
pnpm exec tsx packages/remnic-cli/src/index.ts bench run \
  ama-bench \
  --quick \
  --runtime-profile real \
  --remnic-config ~/.config/remnic/config.json \
  --system-provider openai \
  --system-base-url http://127.0.0.1:1234/v1 \
  --system-model google/gemma-4-26b-a4b \
  --judge-provider openai \
  --judge-base-url http://127.0.0.1:1234/v1 \
  --judge-model google/gemma-4-26b-a4b
```

## Verified Quick Results

### `longmemeval` quick, real profile

- Result file: `~/.remnic/bench/results/longmemeval-v9.3.76-2026-04-19T22-24-53-791Z.json`
- Tasks: `1`
- Mean query latency: `5075ms`
- F1 mean: `0.3333`
- Contains-answer mean: `1.0`
- LLM-judge mean: `1.0`
- Search-hits mean: `0.0`

### `ama-bench` quick, real profile

- Result file: `~/.remnic/bench/results/ama-bench-v9.3.76-2026-04-19T22-39-16-068Z.json`
- Tasks: `2`
- Mean query latency: `5295.5ms`
- F1 mean: `0.2909`
- Contains-answer mean: `1.0`
- LLM-judge mean: `1.0`

## Runner Fix Required To Reach AMA Quick

The official AMA-Bench download contains sparse trajectory turns with `null` `action` and `observation` values. The published runner originally rejected those records. The local fix for this branch normalizes those sparse values to empty strings instead of treating the downloaded corpus as malformed.

Targeted verification passed:

```bash
pnpm exec tsx --test packages/bench/src/benchmarks/published/ama-bench/runner.test.ts
```

## Full Benchmark Sweep Attempt

An all-bench real-profile sweep was attempted. It did not produce a valid full-suite baseline. The failures grouped into four classes.

### 1. Provider-backed runs failing against LM Studio

- `ama-bench`: `OpenAI-compatible completion failed: 400 Bad Request`
- `amemgym`: `OpenAI-compatible completion failed: 400 Bad Request`
- `longmemeval`: `OpenAI-compatible completion failed: 400 Bad Request`

The quick smoke runs prove that the local provider path can work. The remaining `400` errors appear on longer full-mode runs and likely indicate a request-shape or prompt-size mismatch at the harness/provider boundary.

### 2. Downloaded dataset schema mismatches

- `memory-arena`: `formal_reasoning_math.jsonl line 1 must include a string category`
- `locomo`: downloaded fixture shape does not satisfy the current runner contract

These are runner-or-dataset contract problems, not model-quality results.

### 3. Missing full-mode datasets even after `bench datasets download --all`

The following benchmarks still reported missing datasets:

- `beam`
- `personamem`
- `membench`
- `memoryagentbench`
- `taxonomy-accuracy`
- `extraction-judge-calibration`
- `enrichment-fidelity`
- `entity-consolidation`
- `page-versioning`
- `retrieval-personalization`
- `retrieval-temporal`
- `retrieval-direct-answer`
- `procedural-recall`
- `assistant-morning-brief`
- `assistant-meeting-prep`
- `assistant-next-best-action`
- `assistant-synthesis`

That means `bench datasets download --all` does not currently guarantee a runnable full local suite.

### 4. CLI/runtime support gaps for ingestion benchmarks

- `ingestion-entity-recall`
- `ingestion-backlink-f1`
- `ingestion-setup-friction`

These still require a programmatic ingestion adapter and are not runnable end-to-end from the CLI.

Two more ingestion benchmarks also fell back to a code path that does not support `--runtime-profile real`:

- `ingestion-schema-completeness`
- `ingestion-citation-accuracy`

## Test Suite Status

A full `pnpm test` run was started to gather a full local verification baseline. It progressed deep into the suite, then stopped emitting output and went idle at `0.0% CPU` for several minutes. That run is not counted as a pass.

What is verified:

- The targeted AMA regression test passes.
- The local quick real-profile benchmark path works for at least `longmemeval` and `ama-bench`.

What is not yet verified:

- A clean full `pnpm test` result for this branch.
- A clean full `bench run --all --runtime-profile real` baseline against local Gemma.

## Current Conclusion

Remnic can be benchmarked locally against the Gemma model in LM Studio, and the real-profile path is working for at least two published quick benchmarks using QMD and local LLM inference. That is enough to establish a partial local baseline.

It is not yet possible to claim a true full-suite local baseline on this branch. The remaining work is to fix the provider-backed full-run `400` failures, normalize or update the published dataset contracts for `memory-arena` and `locomo`, expand or clarify dataset-download coverage, expose a supported CLI path for ingestion benchmarks, and investigate why the full `pnpm test` tree stalls after substantial progress.
