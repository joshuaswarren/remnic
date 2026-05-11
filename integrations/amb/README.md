# Remnic on Agent Memory Benchmark

This integration lets Remnic run inside the public AMB harness from
`vectorize-io/agent-memory-benchmark`. AMB remains responsible for dataset
loading, answer generation, judge prompts, scoring, and leaderboard-shaped
outputs. Remnic only handles memory ingestion and retrieval.

## Install

```bash
git clone https://github.com/vectorize-io/agent-memory-benchmark.git /tmp/agent-memory-benchmark
cd /path/to/remnic
node integrations/amb/install-remnic-provider.mjs /tmp/agent-memory-benchmark
```

Set the bridge path for the AMB process:

```bash
export REMNIC_REPO_PATH=/path/to/remnic
```

If the default `uv` cache directory is not writable in your environment, point
`uv` at a writable cache before running AMB commands:

```bash
export UV_CACHE_DIR=/tmp/uv-cache-remnic
```

Optional Remnic runtime configuration:

```bash
export REMNIC_AMB_CONFIG_PATH=/path/to/remnic.config.json
export REMNIC_AMB_RECALL_BUDGET_CHARS=49152
export REMNIC_AMB_DRAIN_TIMEOUT_MS=28800000
export REMNIC_AMB_SESSION_PREFIX=beam
export REMNIC_AMB_GROUP_DOCUMENTS_BY_USER=true
```

`REMNIC_AMB_CONFIG_JSON` may be used instead of `REMNIC_AMB_CONFIG_PATH`.
Set only one. By default the bridge preserves Remnic runtime defaults and
waits for ingestion/extraction drain before AMB starts retrieval.
Use `REMNIC_AMB_SESSION_PREFIX=beam` for BEAM runs so Remnic's benchmark
adapter can apply BEAM-specific cue handling while AMB still owns scoring.
By default, the bridge stores all AMB documents with the same `user_id` in one
Remnic session. This preserves BEAM's full per-conversation timeline when AMB
splits a long conversation into multiple document chunks.

For a public-comparable BEAM run, match the model settings used by current AMB
BEAM leaderboard entries:

```bash
export GEMINI_API_KEY=<key> # or GOOGLE_API_KEY=<key>
export OMB_ANSWER_LLM=gemini
export OMB_ANSWER_MODEL=gemini-3.1-pro-preview
export OMB_JUDGE_LLM=gemini
export OMB_JUDGE_MODEL=gemini-2.5-flash-lite
```

For local iteration runs that use the operator's Codex CLI auth instead of
direct benchmark API keys, the installer also registers an AMB LLM provider named
`codex_cli`:

```bash
export OMB_ANSWER_LLM=codex_cli
export OMB_ANSWER_MODEL=gpt-5.5
export OMB_JUDGE_LLM=codex_cli
export OMB_JUDGE_MODEL=gpt-5.5
export OMB_CODEX_REASONING_EFFORT=xhigh
export OMB_CODEX_TIMEOUT_SECONDS=900
```

To route Remnic's internal extraction/planning LLM through the same Codex CLI
transport during AMB runs, add:

```bash
export REMNIC_AMB_INTERNAL_PROVIDER=codex-cli
export REMNIC_AMB_INTERNAL_MODEL=gpt-5.5
export REMNIC_AMB_INTERNAL_CODEX_REASONING_EFFORT=xhigh
export REMNIC_AMB_INTERNAL_TIMEOUT_MS=900000
```

Internal `xhigh` runs can be slow because ingestion may call Codex before AMB
starts answer generation. For quick bridge smoke tests, omit the internal
provider variables or use a lower internal reasoning effort; for serious
improvement runs, keep the internal provider aligned with the answer and judge.

Codex CLI runs are useful for improvement loops and smoke checks, but they are
not a replacement for a public-comparable run unless the target leaderboard uses
the same answer and judge model setup.

Check the local setup before starting a long run:

```bash
node integrations/amb/check-remnic-run.mjs /tmp/agent-memory-benchmark
```

You can also run the same public-comparable BEAM command from GitHub Actions
with the manual `AMB BEAM Remnic` workflow. Configure either the
`GEMINI_API_KEY` or `GOOGLE_API_KEY` repository secret first. The workflow
checks out the public AMB repository, installs the Remnic provider, runs the
same preflight, executes AMB, compares full-split results against the current
public BEAM leaderboard, and uploads the raw result JSON plus comparison
output. Runs with a `query_limit` are smoke runs; the workflow uploads the
partial result but skips the public leaderboard comparison.

## Run

From the AMB checkout:

```bash
uv run omb providers
uv run omb run --dataset beam --split 100k --memory remnic --mode rag --query-limit 20
uv run omb run --dataset personamem --split 32k --memory remnic --mode rag --query-limit 20
```

These commands inherit `REMNIC_REPO_PATH`, the model settings, and the optional
`UV_CACHE_DIR` from the setup shell.

Full BEAM runs follow the same AMB command shape:

```bash
uv run omb run --dataset beam --split 10m --memory remnic --mode rag
```

Current AMB names this response mode `rag` in the CLI. Existing published BEAM
leaderboard artifacts may still label the same single-query RAG flow as
`single-query`.

The AMB result is written by AMB itself under:

```text
outputs/<dataset>/remnic/rag/<split>.json
```

Compress and publish with AMB's own workflow:

```bash
uv run omb publish-results outputs/beam/remnic/rag/10m.json
```

Compare a completed Remnic BEAM result against the current public leaderboard:

```bash
node /path/to/remnic/integrations/amb/compare-beam-result.mjs outputs/beam/remnic/rag/10m.json
```

## Notes

- Use AMB `--mode rag` for comparable single-query retrieval + generated-answer
  runs.
- BEAM has `isolation_unit = "conversation"`. The provider resets Remnic before
  each isolated conversation ingest, matching AMB's unit-sequential evaluation.
- The provider returns Remnic recall context as the retrieved document passed to
  AMB's standard RAG answer prompt. This mirrors providers whose native recall
  returns a synthesized memory context while preserving AMB's scoring pipeline.
