# 2026-04-20 Gemma LM Studio Full-Suite Attempt

## Goal

Retry the full Remnic benchmark suite against the local LM Studio Gemma model on current `main`, after landing the historical 2026-04-19 baseline note.

This note records exactly which model was served, how the context window was increased, what commands were run, and where the current mainline benchmark entrypoint still blocks a clean full-suite execution.

## Repository State

- Date: `2026-04-20 12:35:57 CDT`
- Branch: `main`
- HEAD: `ab5c5d7db344c122198b46056a95c5139d76b831`

This commit includes the historical benchmark record added in:

- `docs(bench): add 2026-04-19 gemma lm studio baseline record`

## Exact LM Studio Model

LM Studio reported the served model as:

- Model ID: `google/gemma-4-26b-a4b`
- Type: `vlm`
- Publisher: `google`
- Architecture: `gemma4`
- Compatibility type: `gguf`
- Quantization: `Q4_K_M`
- Max context length: `262144`
- Loaded context length: `32768`

Captured from:

```bash
curl -s http://127.0.0.1:1234/api/v0/models/google%2Fgemma-4-26b-a4b | jq '{id,type,publisher,arch,compatibility_type,quantization,state,max_context_length,loaded_context_length}'
```

## Context Window Change

Before reload:

- `lms ps` reported `google/gemma-4-26b-a4b` loaded with `CONTEXT 4096`
- `~/Library/Application Support/LM Studio/settings.json` still showed:

```json
{
  "defaultContextLength": {
    "type": "custom",
    "value": 4096
  }
}
```

To increase the active model context window, the model was explicitly reloaded:

```bash
lms unload google/gemma-4-26b-a4b
lms load google/gemma-4-26b-a4b --context-length 32768
```

After reload:

- `lms ps` reported `google/gemma-4-26b-a4b` with `CONTEXT 32768`
- `GET /api/v0/models/google%2Fgemma-4-26b-a4b` confirmed `"loaded_context_length": 32768`

Note: LM Studio's saved default context value in `settings.json` remained `4096`; the active served model context was increased by explicit reload.

## Commands Run

Dataset refresh attempt:

```bash
pnpm exec tsx packages/remnic-cli/src/index.ts bench datasets download --all
```

Full-suite real-profile attempt:

```bash
pnpm exec tsx packages/remnic-cli/src/index.ts bench run \
  --all \
  --runtime-profile real \
  --remnic-config ~/.config/remnic/config.json \
  --system-provider openai \
  --system-base-url http://127.0.0.1:1234/v1 \
  --system-model google/gemma-4-26b-a4b \
  --judge-provider openai \
  --judge-base-url http://127.0.0.1:1234/v1 \
  --judge-model google/gemma-4-26b-a4b
```

## What Happened

### 1. Historical benchmark note was landed on `main`

The historical partial baseline note from 2026-04-19 was committed and pushed to `main` successfully.

### 2. Initial full-suite attempt hit a packaged bench-surface mismatch

The first rerun on current `main` failed immediately with:

```text
Fatal: Installed @remnic/bench runtime does not expose resolveBenchRuntimeProfile().
```

Relevant observations:

- `packages/bench/src/index.ts` exports `resolveBenchRuntimeProfile`
- `packages/bench/dist/index.js` also contains the symbol after rebuild
- the failure occurred at the CLI package/runtime boundary before any benchmark execution

### 3. Native SQLite binding was missing in the `main` worktree

After clearing the bench-surface mismatch, the next rerun failed with:

```text
Fatal: Could not locate the bindings file ... better_sqlite3.node
```

This was resolved locally with:

```bash
pnpm rebuild better-sqlite3
```

### 4. Final full-suite rerun still stalled before producing new results

After the `better-sqlite3` rebuild, the full command started successfully but then:

- stayed alive with `0.0% CPU`
- emitted no benchmark progress to stdout
- produced no new `~/.remnic/bench/results/*.json` files during the rerun window
- left LM Studio reporting Gemma as `IDLE`, which suggests the benchmark entrypoint did not reach active provider-backed generation

In other words, the Gemma model was available and correctly reloaded at `32768`, but the current mainline full-suite CLI path still did not advance into a real benchmark execution.

## Existing Machine Results

This machine already had full-suite result artifacts from earlier on 2026-04-20 under:

- `~/.remnic/bench/results/beam-v9.3.85-2026-04-20T13-22-30-909Z.json`
- `~/.remnic/bench/results/personamem-v9.3.85-2026-04-20T13-22-42-046Z.json`
- `~/.remnic/bench/results/membench-v9.3.85-2026-04-20T13-22-51-359Z.json`
- `~/.remnic/bench/results/memoryagentbench-v9.3.85-2026-04-20T13-23-08-129Z.json`
- `~/.remnic/bench/results/taxonomy-accuracy-v9.3.85-2026-04-20T13-23-11-390Z.json`
- `~/.remnic/bench/results/extraction-judge-calibration-v9.3.85-2026-04-20T13-23-13-294Z.json`
- `~/.remnic/bench/results/enrichment-fidelity-v9.3.85-2026-04-20T13-23-15-223Z.json`
- `~/.remnic/bench/results/entity-consolidation-v9.3.85-2026-04-20T13-23-17-303Z.json`
- `~/.remnic/bench/results/page-versioning-v9.3.85-2026-04-20T13-23-19-172Z.json`
- `~/.remnic/bench/results/retrieval-personalization-v9.3.85-2026-04-20T13-23-20-832Z.json`
- `~/.remnic/bench/results/retrieval-temporal-v9.3.85-2026-04-20T13-23-22-749Z.json`
- `~/.remnic/bench/results/retrieval-direct-answer-v9.3.85-2026-04-20T13-23-26-199Z.json`
- `~/.remnic/bench/results/procedural-recall-v9.3.85-2026-04-20T13-23-29-930Z.json`
- `~/.remnic/bench/results/assistant-morning-brief-v9.3.85-2026-04-20T13-25-09-682Z.json`
- `~/.remnic/bench/results/assistant-meeting-prep-v9.3.85-2026-04-20T13-26-04-773Z.json`
- `~/.remnic/bench/results/assistant-next-best-action-v9.3.85-2026-04-20T13-27-23-577Z.json`
- `~/.remnic/bench/results/assistant-synthesis-v9.3.85-2026-04-20T13-28-29-642Z.json`

Those files prove the suite has been exercised on this machine previously, but this document does not retroactively assert that those earlier runs used the same active Gemma load or the same `32768` context setting. This note only records the verified state and behavior of the 2026-04-20 rerun attempt described above.

## Current Conclusion

What is verified now:

- the 2026-04-19 Gemma baseline record is committed on `main`
- the exact LM Studio-served model is `google/gemma-4-26b-a4b`
- the active loaded Gemma context window was increased from `4096` to `32768`
- current `main` still blocks a clean fresh full-suite rerun through the CLI path, even after clearing the native SQLite binding issue

What remains unresolved:

- why the full-suite benchmark process on current `main` goes idle without producing new benchmark output after startup
- whether the lingering issue is another CLI/package wiring bug, a dataset-stage stall, or a service/bootstrap path that needs explicit diagnostics in the bench runner
