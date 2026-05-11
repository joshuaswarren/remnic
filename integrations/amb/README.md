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

Optional Remnic runtime configuration:

```bash
export REMNIC_AMB_CONFIG_PATH=/path/to/remnic.config.json
export REMNIC_AMB_RECALL_BUDGET_CHARS=49152
export REMNIC_AMB_DRAIN_TIMEOUT_MS=28800000
export REMNIC_AMB_SESSION_PREFIX=beam
```

`REMNIC_AMB_CONFIG_JSON` may be used instead of `REMNIC_AMB_CONFIG_PATH`.
Set only one. By default the bridge preserves Remnic runtime defaults and
waits for ingestion/extraction drain before AMB starts retrieval.
Use `REMNIC_AMB_SESSION_PREFIX=beam` for BEAM runs so Remnic's benchmark
adapter can apply BEAM-specific cue handling while AMB still owns scoring.

## Run

From the AMB checkout:

```bash
uv run amb providers
uv run amb run --dataset beam --split 100k --memory remnic --mode rag --query-limit 20
uv run amb run --dataset personamem --split 32k --memory remnic --mode rag --query-limit 20
```

Full BEAM runs follow the same AMB command shape:

```bash
uv run amb run --dataset beam --split 10m --memory remnic --mode rag
```

The AMB result is written by AMB itself under:

```text
outputs/<dataset>/remnic/rag/<split>.json
```

Compress and publish with AMB's own workflow:

```bash
uv run amb publish-results outputs/beam/remnic/rag/10m.json
```

## Notes

- Use AMB `--mode rag` for comparable retrieval + generated-answer runs.
- BEAM has `isolation_unit = "conversation"`. The provider resets Remnic before
  each isolated conversation ingest, matching AMB's unit-sequential evaluation.
- The provider returns Remnic recall context as the retrieved document passed to
  AMB's standard RAG answer prompt. This mirrors providers whose native recall
  returns a synthesized memory context while preserving AMB's scoring pipeline.
