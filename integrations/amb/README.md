# Remnic AMB Integration

This directory contains a provider adapter for Vectorize's Agent Memory
Benchmark (AMB). AMB's official harness expects a Python
`MemoryProvider`; this adapter registers `remnic` and bridges AMB
documents/queries into Remnic core.

## Install Into AMB

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

## Run

Use the same public process as other AMB providers, with AMB answer and
judge LLMs routed through Codex CLI:

```bash
cd ../agent-memory-benchmark
export REMNIC_REPO=/path/to/remnic
export OMB_ANSWER_LLM=codex
export OMB_JUDGE_LLM=codex
export OMB_ANSWER_MODEL=gpt-5.5
export OMB_JUDGE_MODEL=gpt-5.5
# Optional: set this when the shell default Node does not match
# the native modules installed in the Remnic checkout.
export REMNIC_AMB_NODE=/opt/homebrew/opt/node@22/bin/node

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

The default `rag` mode follows AMB's normal retrieve-then-answer path, with
Codex CLI providing the answer and judge LLMs as `gpt-5.5` with `xhigh`
reasoning and fast service tier. To test AMB `agent` mode with Remnic's
native direct-answer bridge, use the same Codex-backed path:

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
  --min-queries 100 \
  --verify-sota
```

Full leaderboard-style runs must remove `--query-limit`, pin the AMB
commit, pin the Remnic commit, preserve `outputs/.../*.json`, and use the
same Codex CLI LLM path (`codex:gpt-5.5:xhigh:fast`) for answer generation
and judging.

## Notes

- `REMNIC_REPO` must point at this Remnic checkout unless
  `REMNIC_AMB_HELPER` points directly at `remnic-amb-provider.mjs`.
- `REMNIC_AMB_NODE` can point at the Node binary matching this checkout's
  installed native modules. This workspace currently needs Node 22 for
  `better-sqlite3`; using an unrelated Node runtime may require rebuilding
  dependencies first.
- `REMNIC_AMB_CODEX_BIN` can point at a specific Codex CLI binary.
- `REMNIC_AMB_CLI` can force the AMB CLI command name. The wrapper
  auto-detects current `omb` and older `amb` command names.
- The wrapper unsets `GEMINI_API_KEY` and `GOOGLE_API_KEY` before invoking
  AMB and sets `REMNIC_AMB_FORCE_CODEX_LLM=1`, so benchmark LLM calls cannot
  silently fall back to those providers or AMB `.env` overrides.
- The Node helper uses `packages/remnic-core/dist/index.js`; rebuild
  `@remnic/core` after changing core code.
- The adapter scopes AMB `user_id` values to Remnic session ids of the
  form `amb:<user_id>`.
- It returns Remnic recall context plus expanded search evidence as AMB
  `Document` objects. AMB still performs answer generation and judging, but
  this integration routes those LLM calls through Codex CLI rather than
  Gemini, Google, or direct OpenAI API calls.
