# Remnic AMB Integration

This directory contains Remnic adapters for Vectorize's Agent Memory
Benchmark (AMB).

There are two supported paths:

- `install.py`, `remnic.py`, and `remnic-amb-provider.mjs` register Remnic as
  AMB's `remnic` memory provider and add a Codex-backed AMB LLM provider.
- The existing BEAM tooling, including `run-remnic-amb.sh`,
  `install-remnic-provider.mjs`, and `check-remnic-results.mjs`, keeps the
  Hindsight BEAM comparison workflow available.

## Official Provider Install

```bash
git clone https://github.com/vectorize-io/agent-memory-benchmark ../agent-memory-benchmark
pnpm install
pnpm --filter @remnic/core build

python integrations/amb/install.py --amb ../agent-memory-benchmark

cd ../agent-memory-benchmark
export REMNIC_REPO=/path/to/remnic
uv run omb providers
```

The provider should appear as `remnic`.

You can also use the repository wrapper:

```bash
scripts/bench/run-amb-remnic.sh --amb ../agent-memory-benchmark --install-only
```

## PersonaMem / Codex Run

Use the same public AMB process as other providers, with AMB answer and judge
LLMs routed through Codex CLI:

```bash
cd ../agent-memory-benchmark
export REMNIC_REPO=/path/to/remnic
export OMB_ANSWER_LLM=codex
export OMB_JUDGE_LLM=codex
export OMB_ANSWER_MODEL=gpt-5.5
export OMB_JUDGE_MODEL=gpt-5.5
# Optional: set this when the shell default Node does not match the native
# modules installed in the Remnic checkout.
export REMNIC_AMB_NODE=/path/to/node22

uv run omb run \
  --dataset personamem \
  --split 128k \
  --memory remnic \
  --llm codex \
  --query-limit 20
```

Or run the same flow through the wrapper:

```bash
scripts/bench/run-amb-remnic.sh \
  --amb ../agent-memory-benchmark \
  --dataset personamem \
  --split 128k \
  --query-limit 20
```

The default `rag` mode follows AMB's normal retrieve-then-answer path. To test
AMB `agent` mode with Remnic's native direct-answer bridge, use:

```bash
scripts/bench/run-amb-remnic.sh \
  --amb ../agent-memory-benchmark \
  --dataset personamem \
  --split 128k \
  --mode agent \
  --query-limit 20
```

After a full run, add `--verify-sota` to compare the produced result JSON
against AMB's current `external_results.json`:

```bash
scripts/bench/run-amb-remnic.sh \
  --amb ../agent-memory-benchmark \
  --dataset personamem \
  --split 128k \
  --min-queries 2727 \
  --verify-sota
```

Full leaderboard-style runs must remove `--query-limit`, run from clean git
checkouts for both AMB and Remnic, preserve `outputs/.../*.json`, and use the
same Codex CLI LLM path (`codex:gpt-5.5:xhigh:fast`) for answer generation and
judging.

## BEAM / Hindsight Workflow

The legacy BEAM helper script performs registration and sets AMB model defaults
to match the published Hindsight BEAM result artifacts:

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

For local BEAM iteration runs that use Codex CLI auth instead of direct
benchmark API keys, install the provider and check the Codex profile:

```bash
node integrations/amb/install-remnic-provider.mjs /path/to/agent-memory-benchmark

export REMNIC_AMB_RUN_PROFILE=codex-cli
export REMNIC_REPO_PATH=/path/to/remnic
export OMB_ANSWER_LLM=codex_cli
export OMB_ANSWER_MODEL=gpt-5.5
export OMB_JUDGE_LLM=codex_cli
export OMB_JUDGE_MODEL=gpt-5.5
export OMB_CODEX_REASONING_EFFORT=xhigh
export REMNIC_AMB_PRESERVE_RUNTIME_DEFAULTS=false
node integrations/amb/check-remnic-run.mjs /path/to/agent-memory-benchmark
```

The BEAM installer registers an AMB LLM provider named `codex_cli`. Codex CLI
runs are useful for improvement loops and smoke checks, but they are not a
replacement for a public-comparable run unless the target leaderboard uses the
same answer and judge model setup.

## BEAM Public Best Check

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

1. The run uses AMB's normal `omb run` answer/generate/judge loop, not
   `--retrieve-only`, `--skip-answer`, or a separate local scorer.
2. The result artifact is for the intended dataset and split.
3. `total_queries` covers the public full split unless the audit explicitly
   passes `--allow-extra-queries`.
4. The result declares the answer and judge LLM IDs used by the comparison.
5. The result strictly beats the current public best for every requested split,
   unless the reporting context explicitly accepts ties with `--allow-equal`.
6. The relevant verifier exits successfully for the exact artifact paths that
   will be published.
7. The verifier records clean Remnic and AMB git provenance before any SOTA
   claim is published.

The BEAM helper intentionally fails before registering Remnic or building
`@remnic/bench` when an official judged run is requested without
`GEMINI_API_KEY` or `GOOGLE_API_KEY`. `--verify` and `--retrieve-only` remain
keyless diagnostics, but their artifacts are not leaderboard evidence.

## Notes

- `REMNIC_REPO` must point at this Remnic checkout unless
  `REMNIC_AMB_HELPER` points directly at `remnic-amb-provider.mjs`.
- `REMNIC_AMB_NODE` can point at the Node binary matching this checkout's
  installed native modules.
- `REMNIC_AMB_CODEX_BIN` can point at a specific Codex CLI binary.
- `REMNIC_AMB_CLI` can force the AMB CLI command name. The wrapper auto-detects
  current `omb` and older `amb` command names.
- The PersonaMem wrapper unsets `GEMINI_API_KEY` and `GOOGLE_API_KEY` before
  invoking AMB and sets `REMNIC_AMB_FORCE_CODEX_LLM=1`, so benchmark LLM calls
  cannot silently fall back to those providers or AMB `.env` overrides.
- The Node helper uses `packages/remnic-core/dist/index.js`; rebuild
  `@remnic/core` after changing core code.
- The official provider scopes AMB `user_id` values to Remnic session ids of
  the form `amb:<user_id>`.
- AMB still performs answer generation and judging; these integrations only
  register Remnic as a memory provider and, where configured, route AMB LLM
  calls through Codex CLI.
