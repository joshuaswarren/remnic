# Engram Eval Suite

Benchmarks for evaluating Engram's memory system against established memory evaluation frameworks.

## Quick Start

```bash
# Download datasets
npm run eval:download

# Run all benchmarks (full-stack, all Engram features)
npm run eval:bench

# Run a specific benchmark with limited tasks
npm run eval:run -- --benchmark ama-bench --limit 5
```

## Benchmarks

| Benchmark | Category | What it tests |
|-----------|----------|---------------|
| **AMA-Bench** | Agentic | 2-function memorize/recall interface |
| **MemoryArena** | Agentic | Interdependent store → update → cross-reference → recall |
| **AMemGym** | Agentic | Memory-driven personalization |
| **LongMemEval** | Retrieval | Single/cross-session retrieval, temporal reasoning |
| **LoCoMo** | Conversational | Long conversation memory over extended dialogues |

## Adapter Modes

### Full-Stack (default) — exercises ALL Engram features

Creates a sandboxed Orchestrator with isolated temp storage. Exercises the complete pipeline:

- LLM-powered extraction (facts, entities, questions)
- QMD hybrid search (vector + BM25)
- Recall planner (intent routing, budget allocation)
- Query expansion + reranking
- LCM engine (archive, DAG summarization, compressed recall)
- Memory projection, contradiction detection, threading
- Knowledge graph, entity retrieval, trust zones
- Everything agents see in production

**Requires**: LLM endpoint access (OpenAI API key in env) + QMD daemon running.
**Isolation**: Uses temp `memoryDir` + eval-specific QMD collection. No test data touches production.

```bash
npm run eval:run -- --benchmark ama-bench
```

### Lightweight (`--lightweight`) — LCM + FTS only

For CI environments or machines without LLM/QMD access. Exercises only LCM archive, FTS5 search, DAG summarization, and compressed recall.

```bash
npm run eval:run -- --benchmark ama-bench --lightweight
```

### MCP HTTP (`--mcp`) — against running Engram server

Connects to a running Engram HTTP server. Exercises the exact same code path agents use. Start a dedicated eval server (not your production one) to avoid polluting real data.

```bash
# Start a dedicated Engram server with isolated storage, then:
npm run eval:run -- --benchmark ama-bench --mcp --mcp-url http://localhost:18789
```

## CLI Options

```
--benchmark <name|all>   Required. Benchmark to run.
--lightweight            LCM + FTS only (no LLM/QMD needed).
--mcp                    Use MCP HTTP adapter.
--mcp-url <url>          MCP server URL (default: http://localhost:18789).
--mcp-token <token>      MCP auth token.
--limit <n>              Max tasks per benchmark.
--output-dir <path>      Override results directory.
```

## Results

Results are stored as versioned JSON in `evals/results/`:

```
ama-bench-v9.0.0-2026-03-15T14-30-00.json
```

Each result includes: engram version, git SHA, timestamp, per-task scores, aggregate metrics, adapter mode, and config snapshot. Dataset locations inside the repository are stored as portable repo-relative paths; external dataset overrides are recorded as `<external>` so result artifacts do not expose machine-local paths.

## Dataset Download

Datasets are gitignored and must be downloaded before running benchmarks:

```bash
# All datasets
bash evals/scripts/download-datasets.sh

# Single benchmark
bash evals/scripts/download-datasets.sh --benchmark ama-bench
```

## Adding a New Benchmark

1. Create `evals/benchmarks/<name>/runner.ts`
2. Implement the `BenchmarkRunner` interface from `evals/adapter/types.ts`
3. Register it in `evals/run.ts` RUNNERS map
4. Add dataset download to `evals/scripts/download-datasets.sh`
