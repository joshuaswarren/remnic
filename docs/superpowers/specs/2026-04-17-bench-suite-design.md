# Remnic Benchmark Suite — Design Spec

**Date:** 2026-04-17
**Status:** Approved
**Author:** Joshua Warren + Claude

## Overview

A comprehensive benchmarking and evaluation suite for Remnic that provides lab-grade, reproducible measurements of memory system quality. The suite supports published community benchmarks, Remnic-specific benchmarks, and user-defined benchmarks, with flexible LLM provider support for both the system-under-test and the evaluation judge. Results are viewable via a local interactive React dashboard, exportable as static HTML reports, and publishable to Remnic.ai.

### Goals

1. Quantitatively track memory quality over time and across configurations
2. Support ArXiv-grade statistical rigor (bootstrap CIs, effect sizes, seed control)
3. Run with any LLM provider — OpenAI-compatible (Z.ai/GLM, LM Studio, vLLM), Anthropic, Ollama, LiteLLM
4. Provide a fast `--quick` mode for automated improvement loops
5. Remain fully optional — end users of Remnic never encounter benchmark dependencies
6. Enable public benchmarks page on Remnic.ai with auto-updated results

### Non-Goals

- Real-time production monitoring (that's observability, not benchmarking)
- Replacing the existing CI test suite
- Benchmarking non-Remnic memory systems (though the framework could be adapted)

## Architecture

### Two-Package Split

**`@remnic/bench`** — the engine. Contains benchmark runners, LLM provider layer, statistical engine, results schema, CLI commands, dataset management, and JSON/CSV export. Expanded from the existing `packages/bench` package, absorbing `evals/`.

**`@remnic/bench-ui`** — the viewer. React + Tailwind + Recharts dashboard. Serves locally via `remnic bench ui`, exports static HTML reports, and generates JSON data feeds for Remnic.ai. Fully optional — the engine works without it.

**Contract:** The JSON `BenchmarkResult` schema is the interface between them. The engine writes results; the UI reads them.

### Package Structure

```
packages/bench/
├── src/
│   ├── index.ts                    # Barrel exports
│   ├── cli.ts                      # CLI commands under `remnic bench`
│   ├── runner.ts                   # Multi-run orchestrator, seed control, quick mode
│   ├── scorer.ts                   # Scoring utilities (F1, ROUGE-L, exact match, LLM judge)
│   ├── reporter.ts                 # JSON + console output, cost/latency tracking
│   ├── schema.ts                   # BenchmarkResult types + JSON Schema
│   ├── providers/
│   │   ├── types.ts                # LlmProvider interface + DiscoveredModel
│   │   ├── openai.ts               # OpenAI-compatible (Z.ai, LM Studio, vLLM)
│   │   ├── anthropic.ts            # Anthropic API
│   │   ├── ollama.ts               # Local LLMs via Ollama
│   │   └── litellm.ts              # Catch-all via LiteLLM proxy
│   ├── benchmarks/
│   │   ├── registry.ts             # Benchmark registry + discovery
│   │   ├── types.ts                # BenchmarkRunner interface
│   │   ├── published/              # Community benchmarks
│   │   │   ├── ama-bench/          # (existing) Long-horizon agentic memory
│   │   │   ├── memory-arena/       # (existing) Interdependent multi-session
│   │   │   ├── amemgym/            # (existing) Interactive personalization
│   │   │   ├── longmemeval/        # (existing) 5 core memory abilities
│   │   │   ├── locomo/             # (existing) Long conversation memory
│   │   │   ├── beam/               # NEW — 10M token scale, 10 abilities
│   │   │   ├── personamem/         # NEW — Implicit preference learning
│   │   │   ├── memoryagentbench/   # NEW — Selective forgetting
│   │   │   └── membench/           # NEW — Factual vs reflective memory
│   │   ├── remnic/                 # Remnic-specific benchmarks
│   │   │   ├── taxonomy-accuracy/
│   │   │   ├── entity-consolidation/
│   │   │   ├── extraction-judge-calibration/
│   │   │   ├── page-versioning/
│   │   │   └── enrichment-fidelity/
│   │   └── custom/                 # User-defined benchmark framework
│   │       ├── loader.ts           # YAML/JSON benchmark definitions
│   │       └── template.ts         # Scaffold for new benchmarks
│   ├── adapters/                   # Migrated from /evals/adapter/
│   │   ├── types.ts
│   │   ├── engram-adapter.ts
│   │   ├── lightweight-adapter.ts
│   │   ├── mcp-adapter.ts
│   │   └── cmc-adapter.ts
│   ├── stats/
│   │   ├── bootstrap.ts            # Bootstrap resampling, 95% CIs
│   │   ├── effect-size.ts          # Cohen's d, rank-biserial
│   │   └── comparison.ts           # Cross-run and cross-config comparison
│   └── datasets/
│       └── download.ts             # Dataset fetcher
├── package.json
├── tsconfig.json
└── tsup.config.ts

packages/bench-ui/
├── src/
│   ├── App.tsx                     # Root component
│   ├── main.tsx                    # Entry point
│   ├── pages/
│   │   ├── Overview.tsx            # Score cards, trend chart, recent runs
│   │   ├── Runs.tsx                # Full run history with filters
│   │   ├── Compare.tsx             # Side-by-side comparison with CIs
│   │   ├── BenchmarkDetail.tsx     # Per-benchmark deep dive
│   │   └── Providers.tsx           # Provider comparison view
│   ├── components/
│   │   ├── ScoreCard.tsx
│   │   ├── TrendChart.tsx
│   │   ├── RunTable.tsx
│   │   ├── ComparisonTable.tsx
│   │   ├── TaskBreakdown.tsx
│   │   └── CostSummary.tsx
│   ├── lib/
│   │   ├── data.ts                 # Results loading + aggregation
│   │   ├── export.ts               # Static HTML generation
│   │   └── publish.ts              # Remnic.ai JSON feed
│   └── server.ts                   # Local dev server for `remnic bench ui`
├── package.json
├── tsconfig.json
├── tailwind.config.ts
└── vite.config.ts
```

## Results Schema

Every benchmark run produces a `BenchmarkResult`:

```typescript
interface BenchmarkResult {
  meta: {
    id: string;                      // UUID
    benchmark: string;               // e.g. "longmemeval"
    benchmarkTier: "published" | "remnic" | "custom";
    version: string;                 // Benchmark version
    remnicVersion: string;
    gitSha: string;
    timestamp: string;               // ISO 8601
    mode: "full" | "quick";
    runCount: number;                // 1 for quick, N for full
    seeds: number[];
  };
  config: {
    systemProvider: ProviderConfig;   // LLM Remnic used
    judgeProvider: ProviderConfig;    // LLM that scored
    adapterMode: string;             // engram | lightweight | mcp
    remnicConfig: Record<string, unknown>;
  };
  cost: {
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    totalLatencyMs: number;
    meanQueryLatencyMs: number;
  };
  results: {
    tasks: TaskResult[];             // Per-question/task scores
    aggregates: AggregateMetrics;    // Mean, median, min, max per metric
    statistics?: StatisticalReport;  // CIs, effect sizes (null in quick mode)
  };
  environment: {
    os: string;
    nodeVersion: string;
    hardware?: string;
  };
}

interface ProviderConfig {
  provider: "openai" | "anthropic" | "ollama" | "litellm";
  model: string;
  baseUrl?: string;
}

interface AggregateMetrics {
  [metricName: string]: {
    mean: number;
    median: number;
    stdDev: number;
    min: number;
    max: number;
  };
}

interface StatisticalReport {
  confidenceIntervals: {
    [metricName: string]: { lower: number; upper: number; level: 0.95 };
  };
  bootstrapSamples: number;        // Default 1000
  effectSizes?: {                  // Present in comparison mode
    [metricName: string]: {
      cohensD: number;
      interpretation: "negligible" | "small" | "medium" | "large";
    };
  };
  pairedComparison?: {
    baselineId: string;
    pValue: number;
    ciOnDelta: { lower: number; upper: number };
  };
}

interface TaskResult {
  taskId: string;
  question: string;
  expected: string;
  actual: string;
  scores: Record<string, number>;  // e.g. { f1: 0.85, accuracy: 1.0, rougeL: 0.72 }
  latencyMs: number;
  tokens: { input: number; output: number };
}
```

## LLM Provider Layer

### Provider Interface

```typescript
interface LlmProvider {
  id: string;                        // e.g. "openai:gpt-5.5"
  name: string;

  complete(prompt: string, opts?: CompletionOpts): Promise<CompletionResult>;
  embed?(texts: string[]): Promise<number[][]>;

  discover?(): Promise<DiscoveredModel[]>;

  getUsage(): TokenUsage;
  resetUsage(): void;
}

interface DiscoveredModel {
  id: string;
  name: string;
  contextLength: number;
  capabilities: ("completion" | "embedding" | "vision")[];
  quantization?: string;
  parameterCount?: string;
}

interface CompletionResult {
  text: string;
  tokens: { input: number; output: number };
  latencyMs: number;
  model: string;
}
```

### Built-in Providers

| Provider | Covers | Config | Discovery |
|----------|--------|--------|-----------|
| `openai` | OpenAI, Z.ai/GLM, vLLM, LM Studio | `baseUrl` + `apiKey` + `model` | Yes — `/v1/models` + `lms ls` CLI |
| `anthropic` | Claude models | `apiKey` + `model` | No |
| `ollama` | Local models | `host` + `model` | Yes — `ollama list` |
| `litellm` | 100+ providers via proxy | `baseUrl` + `model` | No |

The `openai` provider handles LM Studio auto-discovery by probing the `/v1/models` endpoint for extended metadata (context length, capabilities) and falling back to `lms ls` CLI output when available.

### Configuration

```yaml
# bench.config.yaml
judge:
  provider: openai
  baseUrl: https://api.z.ai/v1
  model: glm-5.1
  apiKey: ${ZAI_API_KEY}

system:
  provider: openai
  model: gpt-5.5
  apiKey: ${OPENAI_API_KEY}

runs:
  count: 5
  seeds: [42, 123, 456, 789, 1024]

benchmarks:
  - longmemeval
  - beam
  - personamem
  - remnic:taxonomy-accuracy
```

Quick mode overrides `runs.count` to 1 and skips statistical computations. The full config is snapshot into every result JSON.

## Benchmark Tiers

### Tier 1 — Published Community Benchmarks (9)

| Benchmark | What it tests | Scale | Status |
|-----------|--------------|-------|--------|
| AMA-Bench | Long-horizon agentic memory | 2,496 QA pairs | Existing |
| MemoryArena | Interdependent multi-session tasks | 4,850 subtasks | Existing |
| AMemGym | Interactive personalization (ICLR 2026) | 200 QA pairs | Existing |
| LongMemEval | 5 core memory abilities (ICLR 2025) | 500 questions | Existing |
| LoCoMo | Long conversation memory | 1,986 QA pairs | Existing |
| BEAM | Extreme scale, 10 abilities (ICLR 2026) | 2,000 questions | New |
| PersonaMem-v2 | Implicit preference learning | 20,000+ preferences | New |
| MemoryAgentBench | Selective forgetting + incremental (ICLR 2026) | Multi-turn | New |
| MemBench | Factual vs reflective (ACL 2025) | Multi-level | New |

### Tier 2 — Remnic-Specific Benchmarks (5)

| Benchmark | What it tests | Method |
|-----------|--------------|--------|
| Taxonomy Accuracy | MECE categorization correctness | Synthetic facts with known categories, classification F1 |
| Entity Consolidation | Merge quality for evolving entities | Seed duplicate/evolving mentions, dedup precision/recall |
| Extraction Judge Calibration | Judge agreement with human labels | Pre-labeled fact set, sensitivity/specificity |
| Page Versioning | Snapshot correctness under concurrent writes | Write/overwrite sequences, version chain integrity |
| Enrichment Fidelity | External enrichment accuracy | Known-answer targets, precision of added context |

### Tier 3 — User-Defined Benchmarks

Users define benchmarks via YAML:

```yaml
name: "My memory quality check"
description: "Tests recall of key project facts"
tasks:
  - question: "What is the deployment cadence for Project X?"
    expected: "Weekly on Tuesdays"
    tags: [project, deployment]
  - question: "Who owns the billing integration?"
    expected: "Sarah on the platform team"
    tags: [team, ownership]
scoring: llm_judge  # or exact_match, rouge_l, f1
```

Run with `remnic bench run --custom my-benchmark.yaml`.

## Statistical Engine

### Full Mode (default)

- N runs per benchmark (configurable, default 5) with different seeds
- Per-metric aggregates: mean, median, std dev, min, max
- Bootstrap 95% CIs with 1,000 resamples per metric
- Cohen's d effect sizes for cross-config comparisons
- Paired t-test p-values and CIs on deltas when comparing by task ID
- Per-query token cost and latency tracked, aggregated per-run
- All raw per-task scores preserved for downstream analysis

### Quick Mode (`--quick`)

- Single run, seed 42
- Raw aggregates only (mean, min, max)
- No CIs, no effect sizes, no paired comparisons
- Results tagged `mode: "quick"` — clearly distinguished in viewer
- Exit code 0/1 based on configurable regression threshold
- Designed for automated improvement loops

### Comparison Engine

```bash
remnic bench compare run-abc run-def          # Two specific runs
remnic bench compare --baseline main          # Current vs stored baseline
remnic bench compare --group-by system.model  # Cross-config comparison
```

Outputs: deltas, CIs on delta, effect sizes, pass/fail verdict per metric.

## CLI Interface

```bash
# Discovery
remnic bench list                             # List available benchmarks
remnic bench providers discover               # Auto-detect local models

# Running
remnic bench run longmemeval                  # Full mode (5 runs)
remnic bench run --quick longmemeval          # Quick mode (1 run)
remnic bench run --all                        # All benchmarks
remnic bench run --tier published             # Only community benchmarks
remnic bench run --custom my-bench.yaml       # User-defined
remnic bench run --config bench.config.yaml   # Explicit config

# Comparing
remnic bench compare run-abc run-def
remnic bench compare --baseline main
remnic bench compare --group-by system.model

# Results
remnic bench results                          # List stored results
remnic bench results run-abc --detail         # Per-task breakdown
remnic bench baseline save                    # Snapshot as baseline
remnic bench baseline list                    # List baselines

# Export & Publish
remnic bench export --format html             # Static HTML report
remnic bench export --format json             # Raw JSON
remnic bench export --format csv              # Spreadsheet
remnic bench publish --target remnic-ai       # Push to Remnic.ai

# Dashboard
remnic bench ui                               # Local React dashboard

# Datasets
remnic bench datasets download                # All datasets
remnic bench datasets download beam           # Specific dataset
```

### Agent Integration

- `--quick` for fast single-run feedback in automated loops
- `--json` on any command for machine-parseable output
- Exit codes: 0 = pass, 1 = regression, 2 = error
- `--threshold 0.05` on compare for regression sensitivity
- Non-interactive — no prompts, no TTY required
- Predictable result paths: `~/.remnic/bench/results/{id}.json`

### Programmatic API

```typescript
import { runBenchmark, compare } from "@remnic/bench";

const result = await runBenchmark("longmemeval", {
  mode: "quick",
  judge: { provider: "openai", baseUrl: "https://api.z.ai/v1", model: "glm-5.1" },
  system: { provider: "openai", model: "gpt-5.5" },
});
```

## Dashboard UI (`@remnic/bench-ui`)

### Stack

- React 19 + TypeScript
- Tailwind CSS 4
- Recharts for data visualization
- Vite for build/dev server

### Views

1. **Overview** — score cards per benchmark (value + delta + CI), score trend chart (7d/30d/90d/all), recent runs table (ID, benchmark, mode, system LLM, judge, score, delta, cost)
2. **Runs** — full history with filters by benchmark, provider, mode, date range
3. **Compare** — side-by-side two runs or configs with paired CIs, effect sizes, per-task deltas
4. **Benchmark Detail** — per-benchmark deep dive with task-level breakdowns, score distributions, failure analysis
5. **Providers** — compare how different system LLMs and judges affect scores across benchmarks

### Output Surfaces

1. **Local interactive dashboard** — `remnic bench ui` serves at localhost
2. **Static HTML export** — self-contained single HTML file with embedded data, Tailwind, and lightweight charts
3. **Remnic.ai JSON feed** — exported JSON consumed by the Astro site at build time for a public benchmarks page

## Phased Implementation

### Phase 1 — Engine Foundation (PR #1, ~400 LOC)

- Expand `@remnic/bench` with new directory structure
- `LlmProvider` interface + OpenAI-compatible provider
- `BenchmarkResult` schema (types + JSON Schema)
- Migrate `/evals` runners into `benchmarks/published/`
- Migrate scorer, reporter, adapters
- `remnic bench run` and `remnic bench list` CLI
- Quick mode end-to-end with one benchmark
- **Ship criteria:** `remnic bench run --quick longmemeval` produces valid results JSON

### Phase 2 — Statistical Rigor + New Benchmarks (PR #2, ~400 LOC)

- Multi-run orchestration with seed control
- Bootstrap CI, Cohen's d, paired comparison engine
- Anthropic + Ollama + LiteLLM providers
- LM Studio auto-discovery
- 4 new published benchmark runners (BEAM, PersonaMem-v2, MemoryAgentBench, MemBench)
- Dataset download for new benchmarks
- `remnic bench compare` command
- **Ship criteria:** Full-mode 5-run with CIs, new benchmarks produce results, compare shows effect sizes

### Phase 3 — Remnic-Specific Benchmarks + Custom Framework (PR #3, ~300 LOC)

- 5 Remnic-specific benchmark runners
- Custom benchmark YAML loader + runner
- `remnic bench baseline save/list`
- CI gate update (`eval-benchmark-gate.yml`)
- `remnic bench export --format json/csv`
- **Ship criteria:** All three tiers runnable, baselines working, CI gate passes

### Phase 4 — Dashboard & Publishing (PR #4, ~500 LOC)

- `@remnic/bench-ui` package: React + Tailwind + Recharts
- All 5 views (Overview, Runs, Compare, Benchmark Detail, Providers)
- Static HTML export
- `remnic bench publish --target remnic-ai` JSON feed
- `remnic bench ui` command
- **Ship criteria:** Dashboard renders real results, static export self-contained, JSON feed works

### Phase 5 — Remnic.ai Integration (PR #5, separate repo)

- Benchmarks page in Astro site consuming JSON feed
- Public leaderboard with Remnic vs published baselines
- CI-driven auto-update when new baselines are published

## References

### Benchmarks

- LongMemEval (ICLR 2025): github.com/xiaowu0162/LongMemEval
- BEAM (ICLR 2026): github.com/mohammadtavakoli78/BEAM
- LoCoMo: snap-research.github.io/locomo
- MemBench (ACL 2025): arxiv.org/abs/2506.21605
- MemoryAgentBench (ICLR 2026): github.com/HUST-AI-HYZ/MemoryAgentBench
- MemoryArena: memoryarena.github.io
- AMA-Bench: ama-bench.github.io
- PersonaMem-v2: huggingface.co/datasets/bowen-upenn/PersonaMem-v2

### Evaluation Frameworks

- RAGAS: github.com/vibrantlabsai/ragas
- DeepEval: github.com/confident-ai/deepeval

### Standards

- BetterBench (NeurIPS 2024): betterbench.stanford.edu
- ABC Agent Benchmarking Checklist: arxiv.org/abs/2507.02825

### Surveys

- "Memory in the Age of AI Agents" (Dec 2025): arxiv.org/abs/2512.13564
- "Anatomy of Agentic Memory" (Feb 2026): arxiv.org/abs/2602.19320
