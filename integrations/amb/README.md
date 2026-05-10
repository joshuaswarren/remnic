# Remnic AMB Provider

This integration lets Agent Memory Benchmark (AMB) run its own public
ingest/retrieve/generate/judge loop while using Remnic as the memory provider.

## Install Into AMB

The helper script performs the registration and sets the AMB model defaults to
match the published Hindsight BEAM result artifacts:

```bash
integrations/amb/run-remnic-amb.sh \
  --amb-dir /path/to/agent-memory-benchmark \
  --split 100k \
  --mode rag \
  --query-limit 20 \
  --name remnic-100k-smoke
```

Use `--skip-run` to register the provider without launching an evaluation.
Use `--verify` to register the provider and run a no-Gemini Remnic
ingest/retrieve smoke through AMB's provider API.
Use `--retrieve-only` to run AMB BEAM ingestion/retrieval and write retrieved
contexts without answer generation or judging. Retrieval diagnostics do not
count as leaderboard results.

Manual setup:

From an `agent-memory-benchmark` checkout:

```bash
cp /path/to/remnic/integrations/amb/remnic_provider.py src/memory_bench/memory/remnic.py
```

Then add Remnic to `src/memory_bench/memory/__init__.py`:

```python
from .remnic import RemnicMemoryProvider

REGISTRY["remnic"] = RemnicMemoryProvider
```

Build Remnic's benchmark package before running:

```bash
cd /path/to/remnic
pnpm --filter @remnic/bench build
```

## Run

```bash
cd /path/to/agent-memory-benchmark
export REMNIC_REPO_ROOT=/path/to/remnic
export GEMINI_API_KEY=...
OMB_ANSWER_LLM=gemini \
OMB_ANSWER_MODEL=gemini-3.1-pro-preview \
OMB_JUDGE_LLM=gemini \
OMB_JUDGE_MODEL=gemini-2.5-flash-lite \
uv run omb run --dataset beam --split 100k --memory remnic --mode rag --name remnic
```

## Check Against Public Best

After running AMB, compare Remnic's BEAM result files against AMB's current
`results-manifest.json`:

```bash
integrations/amb/check-remnic-results.mjs \
  --amb-dir /path/to/agent-memory-benchmark \
  --run-name remnic \
  --mode rag \
  --output-dir outputs
```

The checker requires Remnic to beat the current public best on every requested
split by default and requires `total_queries` to cover the public full split.
This prevents a `--query-limit` smoke run from being mistaken for a leaderboard
result. It also requires the answer and judge LLM IDs to match the published
Hindsight BEAM artifact defaults unless overridden with `--answer-llm` and
`--judge-llm`. Add `--allow-equal` only if a tie should count as SOTA for a
specific reporting context.

Use `--mode any` only for audits where exactly one Remnic result exists per
split under the run name. The checker fails if multiple mode directories contain
a result for the same split.

## Publishable SOTA Checklist

A Remnic BEAM result is publishable/comparable only when all of these are true:

1. The run uses AMB's normal `omb run` answer/generate/judge loop, not
   `--retrieve-only`, `--skip-answer`, or a separate local scorer.
2. The result artifact is for `dataset: "beam"` and the requested split.
3. `total_queries` equals the current public full split count in AMB's
   `results-manifest.json` unless the audit explicitly passes
   `--allow-extra-queries`.
4. `answer_llm` is `gemini:gemini-3.1-pro-preview` and `judge_llm` is
   `gemini:gemini-2.5-flash-lite`, matching the published Hindsight BEAM
   artifacts, unless the comparison explicitly declares a different model pair.
5. The result strictly beats the current public best for every requested split,
   unless the reporting context explicitly accepts ties with `--allow-equal`.
6. `integrations/amb/check-remnic-results.mjs` exits successfully for the exact
   artifact paths that will be published.

The helper script intentionally fails before registering Remnic or building
`@remnic/bench` when an official judged run is requested without
`GEMINI_API_KEY` or `GOOGLE_API_KEY`. `--verify` and `--retrieve-only` remain
keyless diagnostics, but their artifacts are not leaderboard evidence.

Useful diagnostic limits:

```bash
uv run omb run --dataset beam --split 100k --memory remnic --mode rag --query-limit 20 --name remnic-100k-smoke
```

Gemini-free retrieval diagnostic:

```bash
integrations/amb/run-remnic-amb.sh \
  --amb-dir /path/to/agent-memory-benchmark \
  --split 100k \
  --query-limit 20 \
  --name remnic-100k-retrieval-smoke \
  --retrieve-only
```

## Notes

- AMB owns answer generation and judging. Remnic only implements the memory
  provider `ingest()` and `retrieve()` contract.
- The bridge uses Remnic's full `@remnic/bench` direct adapter by default.
- AMB passes its per-run `store_dir` into the Remnic bridge, so the memory
  state used for an output artifact is isolated under the AMB output tree.
- The provider derives the dataset name from AMB's `store_dir` and prefixes
  Remnic sessions with it, e.g. BEAM conversations use `beam-...` session IDs.
  Set `REMNIC_AMB_SESSION_PREFIX` only when running outside AMB's normal output
  layout.
- `REMNIC_AMB_PRESERVE_RUNTIME_DEFAULTS=0` is available only for diagnostics;
  leave it unset for public-comparable runs so the full Remnic stack is used.
- Published Hindsight BEAM artifacts currently use `gemini-3.1-pro-preview`
  for answer generation and `gemini-2.5-flash-lite` for judging.
- The current AMB CLI registers `rag`, `agentic-rag`, and `agent` response
  modes. Some existing published artifacts are stored under `single-query`;
  that is not a registered mode in the current upstream checkout.
- Set `REMNIC_AMB_CONFIG_JSON` to pass Remnic config overrides as JSON.
- Set `REMNIC_AMB_RECALL_BUDGET_CHARS` to control returned recall context size.
