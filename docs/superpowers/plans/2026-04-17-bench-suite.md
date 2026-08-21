# Remnic Benchmark Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a comprehensive, multi-provider benchmarking suite with statistical rigor, a React dashboard, and public publishing to Remnic.ai.

**Architecture:** Two packages — `@remnic/bench` (engine: runners, providers, stats, CLI) and `@remnic/bench-ui` (React + Tailwind + Recharts dashboard). The engine absorbs the existing `evals/` directory. A `BenchmarkResult` JSON schema is the contract between them.

**Tech Stack:** TypeScript, Node 22+, React 19, Tailwind CSS 4, Recharts, Vite, tsup

**Design Spec:** `docs/superpowers/specs/2026-04-17-bench-suite-design.md`

---

## Phase 1 — Engine Foundation

Phase 1 expands `@remnic/bench` from a latency-only tool into the full benchmark engine. It migrates `evals/` into the package, adds the provider abstraction, defines the new results schema, and wires up the CLI. At the end of this phase, `remnic bench run --quick longmemeval` works end-to-end.

### Task 1.1: Define the new results schema and provider types

This task creates the type foundations everything else builds on. The existing `packages/bench/src/types.ts` keeps its latency-ladder types; the new schema lives in `schema.ts`. The provider interface lives in `providers/types.ts`.

**Files:**
- Create: `packages/bench/src/schema.ts`
- Create: `packages/bench/src/providers/types.ts`

- [ ] **Step 1: Create `packages/bench/src/schema.ts`**

```typescript
export interface ProviderConfig {
  provider: "openai" | "anthropic" | "ollama" | "litellm";
  model: string;
  baseUrl?: string;
}

export interface TaskResult {
  taskId: string;
  question: string;
  expected: string;
  actual: string;
  scores: Record<string, number>;
  latencyMs: number;
  tokens: { input: number; output: number };
}

export interface AggregateMetrics {
  [metricName: string]: {
    mean: number;
    median: number;
    stdDev: number;
    min: number;
    max: number;
  };
}

export interface StatisticalReport {
  confidenceIntervals: {
    [metricName: string]: { lower: number; upper: number; level: 0.95 };
  };
  bootstrapSamples: number;
  effectSizes?: {
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

export interface BenchmarkResultMeta {
  id: string;
  benchmark: string;
  benchmarkTier: "published" | "remnic" | "custom";
  version: string;
  remnicVersion: string;
  gitSha: string;
  timestamp: string;
  mode: "full" | "quick";
  runCount: number;
  seeds: number[];
}

export interface CostReport {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  totalLatencyMs: number;
  meanQueryLatencyMs: number;
}

export interface EnvironmentInfo {
  os: string;
  nodeVersion: string;
  hardware?: string;
}

export interface BenchmarkResult {
  meta: BenchmarkResultMeta;
  config: {
    systemProvider: ProviderConfig;
    judgeProvider: ProviderConfig;
    adapterMode: string;
    remnicConfig: Record<string, unknown>;
  };
  cost: CostReport;
  results: {
    tasks: TaskResult[];
    aggregates: AggregateMetrics;
    statistics?: StatisticalReport;
  };
  environment: EnvironmentInfo;
}

export interface BenchmarkMeta {
  name: string;
  version: string;
  description: string;
  category: "agentic" | "retrieval" | "conversational" | "remnic" | "custom";
  tier: "published" | "remnic" | "custom";
  citation?: string;
}

export interface BenchmarkRunOptions {
  limit?: number;
  datasetDir: string;
  mode: "full" | "quick";
  seed: number;
}

export interface BenchmarkRunner {
  meta: BenchmarkMeta;
  run(
    system: MemorySystem,
    judge: LlmJudge | undefined,
    options: BenchmarkRunOptions,
  ): Promise<BenchmarkResult>;
}

export { type MemorySystem, type LlmJudge } from "./adapters/types.js";
```

- [ ] **Step 2: Create `packages/bench/src/providers/types.ts`**

```typescript
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionOpts {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export interface CompletionResult {
  text: string;
  tokens: { input: number; output: number };
  latencyMs: number;
  model: string;
}

export interface DiscoveredModel {
  id: string;
  name: string;
  contextLength: number;
  capabilities: ("completion" | "embedding" | "vision")[];
  quantization?: string;
  parameterCount?: string;
}

export interface LlmProvider {
  id: string;
  name: string;

  complete(prompt: string, opts?: CompletionOpts): Promise<CompletionResult>;
  embed?(texts: string[]): Promise<number[][]>;
  discover?(): Promise<DiscoveredModel[]>;

  getUsage(): TokenUsage;
  resetUsage(): void;
}

export interface ProviderFactoryConfig {
  provider: "openai" | "anthropic" | "ollama" | "litellm";
  model: string;
  baseUrl?: string;
  apiKey?: string;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/bench/src/schema.ts packages/bench/src/providers/types.ts
git commit -m "feat(bench): add BenchmarkResult schema and LlmProvider interface"
```

---

### Task 1.2: Implement the OpenAI-compatible provider

This provider covers OpenAI, Z.ai/GLM, LM Studio, and vLLM — any service exposing an OpenAI-compatible `/v1/chat/completions` and `/v1/models` endpoint.

**Files:**
- Create: `packages/bench/src/providers/openai.ts`
- Create: `packages/bench/src/providers/__tests__/openai.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/bench/src/providers/__tests__/openai.test.ts
import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "../openai.js";

describe("OpenAIProvider", () => {
  it("tracks token usage across calls", async () => {
    const provider = new OpenAIProvider({
      model: "gpt-5.5",
      apiKey: "test-key",
    });
    // Mock fetch to return a fake completion
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "test response" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      model: "gpt-5.5",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await provider.complete("test prompt");
    const usage = provider.getUsage();
    assert.equal(usage.inputTokens, 10);
    assert.equal(usage.outputTokens, 5);

    provider.resetUsage();
    const reset = provider.getUsage();
    assert.equal(reset.inputTokens, 0);
    assert.equal(reset.outputTokens, 0);

    globalThis.fetch = originalFetch;
  });

  it("uses custom baseUrl for Z.ai / LM Studio", () => {
    const provider = new OpenAIProvider({
      model: "glm-5.1",
      baseUrl: "https://api.z.ai/v1",
      apiKey: "z-key",
    });
    assert.equal(provider.id, "openai:glm-5.1");
    assert.equal(provider.name, "glm-5.1 (https://api.z.ai/v1)");
  });

  it("discovers models via /v1/models endpoint", async () => {
    const provider = new OpenAIProvider({
      model: "test",
      baseUrl: "http://localhost:1234/v1",
      apiKey: "test",
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "llama-3.1-8b", owned_by: "local", context_length: 8192 },
        { id: "qwen-2.5-coder", owned_by: "local", context_length: 32768 },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const models = await provider.discover!();
    assert.equal(models.length, 2);
    assert.equal(models[0].id, "llama-3.1-8b");
    assert.equal(models[0].contextLength, 8192);

    globalThis.fetch = originalFetch;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/bench/src/providers/__tests__/openai.test.ts`
Expected: FAIL — `Cannot find module '../openai.js'`

- [ ] **Step 3: Implement `packages/bench/src/providers/openai.ts`**

```typescript
import type {
  LlmProvider,
  TokenUsage,
  CompletionOpts,
  CompletionResult,
  DiscoveredModel,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export class OpenAIProvider implements LlmProvider {
  readonly id: string;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(config: { model: string; baseUrl?: string; apiKey?: string }) {
    this.model = config.model;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? "";
    this.id = `openai:${this.model}`;
    this.name =
      this.baseUrl === DEFAULT_BASE_URL
        ? this.model
        : `${this.model} (${this.baseUrl})`;
  }

  async complete(prompt: string, opts?: CompletionOpts): Promise<CompletionResult> {
    const start = performance.now();
    const messages: Array<{ role: string; content: string }> = [];
    if (opts?.systemPrompt) {
      messages.push({ role: "system", content: opts.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts?.temperature ?? 0,
        ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }

    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
      model: string;
    };

    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    this.usage.inputTokens += inputTokens;
    this.usage.outputTokens += outputTokens;

    return {
      text: json.choices[0]?.message?.content ?? "",
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs: Math.round(performance.now() - start),
      model: json.model,
    };
  }

  async discover(): Promise<DiscoveredModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        data: Array<{
          id: string;
          owned_by?: string;
          context_length?: number;
          max_model_len?: number;
        }>;
      };
      return json.data.map((m) => ({
        id: m.id,
        name: m.id,
        contextLength: m.context_length ?? m.max_model_len ?? 0,
        capabilities: ["completion" as const],
      }));
    } catch {
      return [];
    }
  }

  getUsage(): TokenUsage {
    return { ...this.usage };
  }

  resetUsage(): void {
    this.usage = { inputTokens: 0, outputTokens: 0 };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/bench/src/providers/__tests__/openai.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/bench/src/providers/openai.ts packages/bench/src/providers/__tests__/openai.test.ts
git commit -m "feat(bench): add OpenAI-compatible LLM provider with discovery"
```

---

### Task 1.3: Migrate adapters from `evals/adapter/` into `packages/bench/src/adapters/`

Move the adapter types and implementations into the bench package so benchmark runners can import them from `@remnic/bench`.

**Files:**
- Create: `packages/bench/src/adapters/types.ts` (copy from `evals/adapter/types.ts`)
- Create: `packages/bench/src/adapters/engram-adapter.ts` (copy from `evals/adapter/engram-adapter.ts`)
- Create: `packages/bench/src/adapters/lightweight-adapter.ts` (copy from `evals/adapter/engram-adapter.ts` — the lightweight factory lives there)
- Create: `packages/bench/src/adapters/mcp-adapter.ts` (copy from `evals/adapter/mcp-adapter.ts`)
- Create: `packages/bench/src/adapters/cmc-adapter.ts` (copy from `evals/adapter/cmc-adapter.ts`)
- Modify: `evals/adapter/types.ts` — re-export from `@remnic/bench` for backward compat

- [ ] **Step 1: Copy adapter files into `packages/bench/src/adapters/`**

```bash
mkdir -p packages/bench/src/adapters
cp evals/adapter/types.ts packages/bench/src/adapters/types.ts
cp evals/adapter/engram-adapter.ts packages/bench/src/adapters/engram-adapter.ts
cp evals/adapter/mcp-adapter.ts packages/bench/src/adapters/mcp-adapter.ts
cp evals/adapter/cmc-adapter.ts packages/bench/src/adapters/cmc-adapter.ts
```

- [ ] **Step 2: Update import paths in copied adapter files**

Each copied file references `./types.js` — these should remain valid since the relative structure is preserved. Check that `@remnic/core` imports resolve correctly (they should, since `packages/bench/package.json` already depends on `@remnic/core`).

- [ ] **Step 3: Replace `evals/adapter/types.ts` with re-export shim**

```typescript
// evals/adapter/types.ts — backward compat shim
export type {
  Message,
  SearchResult,
  MemoryStats,
  LlmJudge,
  MemorySystem,
  BenchmarkTask,
  TaskScore,
  BenchmarkMeta,
  BenchmarkResult,
  BenchmarkRunner,
} from "@remnic/bench";
```

- [ ] **Step 4: Verify existing evals still compile**

Run: `npx tsc --noEmit -p evals/tsconfig.json 2>/dev/null || npx tsx evals/run.ts --help`
Expected: Help text prints without errors

- [ ] **Step 5: Commit**

```bash
git add packages/bench/src/adapters/ evals/adapter/types.ts
git commit -m "refactor(bench): migrate eval adapters into @remnic/bench package"
```

---

### Task 1.4: Migrate scorer and reporter into `packages/bench/src/`

Move the scoring utilities and reporter into the bench package.

**Files:**
- Create: `packages/bench/src/scorer.ts` (copy from `evals/scorer.ts`)
- Create: `packages/bench/src/reporter.ts` (rewrite from `evals/reporter.ts` to use new schema)

- [ ] **Step 1: Copy scorer into bench package**

```bash
cp evals/scorer.ts packages/bench/src/scorer.ts
```

No import changes needed — scorer.ts is self-contained.

- [ ] **Step 2: Create new reporter using `BenchmarkResult` schema**

```typescript
// packages/bench/src/reporter.ts
import { writeFile, mkdir } from "node:fs/promises";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { BenchmarkResult, EnvironmentInfo, ProviderConfig } from "./schema.js";

export function getRemnicVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf-8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function getGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

export function getEnvironment(): EnvironmentInfo {
  return {
    os: `${os.platform()} ${os.release()}`,
    nodeVersion: process.version,
  };
}

export function generateResultId(): string {
  return randomUUID().slice(0, 7);
}

export async function writeResult(
  result: BenchmarkResult,
  outputDir: string,
): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${result.meta.benchmark}-${result.meta.mode}-${ts}-${result.meta.id}.json`;
  const filePath = path.join(outputDir, filename);
  await writeFile(filePath, JSON.stringify(result, null, 2) + "\n");
  return filePath;
}

export function printSummary(result: BenchmarkResult): void {
  const { meta, cost, results } = result;
  console.log("\n" + "=".repeat(60));
  console.log(`Benchmark: ${meta.benchmark} (${meta.benchmarkTier})`);
  console.log(`Mode:      ${meta.mode} (${meta.runCount} run${meta.runCount > 1 ? "s" : ""})`);
  console.log(`Remnic:    v${meta.remnicVersion} (${meta.gitSha})`);
  console.log(`Cost:      ${cost.totalTokens} tokens ($${cost.estimatedCostUsd.toFixed(4)})`);
  console.log(`Duration:  ${(cost.totalLatencyMs / 1000).toFixed(1)}s`);
  console.log("-".repeat(60));

  const metrics = results.aggregates;
  const keys = Object.keys(metrics).sort();
  if (keys.length === 0) {
    console.log("  (no aggregate metrics)");
  } else {
    for (const key of keys) {
      const m = metrics[key];
      console.log(`  ${key.padEnd(24)} mean=${m.mean.toFixed(4)}  [${m.min.toFixed(4)}, ${m.max.toFixed(4)}]`);
    }
  }

  if (results.statistics?.confidenceIntervals) {
    console.log("-".repeat(60));
    console.log("95% Confidence Intervals:");
    for (const [key, ci] of Object.entries(results.statistics.confidenceIntervals)) {
      console.log(`  ${key.padEnd(24)} [${ci.lower.toFixed(4)}, ${ci.upper.toFixed(4)}]`);
    }
  }

  console.log("=".repeat(60) + "\n");
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/bench/src/scorer.ts packages/bench/src/reporter.ts
git commit -m "refactor(bench): migrate scorer and reporter into @remnic/bench"
```

---

### Task 1.5: Migrate existing benchmark runners

Move the 5 existing runners into `packages/bench/src/benchmarks/published/`. Update their imports to use package-local paths.

**Files:**
- Create: `packages/bench/src/benchmarks/published/ama-bench/runner.ts`
- Create: `packages/bench/src/benchmarks/published/memory-arena/runner.ts`
- Create: `packages/bench/src/benchmarks/published/amemgym/runner.ts`
- Create: `packages/bench/src/benchmarks/published/longmemeval/runner.ts`
- Create: `packages/bench/src/benchmarks/published/locomo/runner.ts`
- Create: `packages/bench/src/benchmarks/registry.ts`

- [ ] **Step 1: Copy runners and fix imports**

```bash
mkdir -p packages/bench/src/benchmarks/published/{ama-bench,memory-arena,amemgym,longmemeval,locomo}
cp evals/benchmarks/ama-bench/runner.ts packages/bench/src/benchmarks/published/ama-bench/runner.ts
cp evals/benchmarks/memory-arena/runner.ts packages/bench/src/benchmarks/published/memory-arena/runner.ts
cp evals/benchmarks/amemgym/runner.ts packages/bench/src/benchmarks/published/amemgym/runner.ts
cp evals/benchmarks/longmemeval/runner.ts packages/bench/src/benchmarks/published/longmemeval/runner.ts
cp evals/benchmarks/locomo/runner.ts packages/bench/src/benchmarks/published/locomo/runner.ts
```

In each copied runner, update imports and migrate to the new `BenchmarkResult` schema. Runners move from `evals/benchmarks/<name>/` (2 levels deep) to `packages/bench/src/benchmarks/published/<name>/` (3 levels deep under `src/`), so relative paths need an extra `../`:
- `../../adapter/types.js` → `../../../adapters/types.js`
- `../../scorer.js` → `../../../scorer.js`
- `../../reporter.js` → `../../../reporter.js`

Additionally, update each runner's `run()` method to return the new `BenchmarkResult` shape (Task 1.1 schema) instead of the legacy shape. Replace `enrichResult()` calls with direct construction of the `BenchmarkResult` object using `buildResultMeta()` from `../../../runner.js` and the new `AggregateMetrics`/`TaskResult` interfaces.

- [ ] **Step 2: Create the benchmark registry**

```typescript
// packages/bench/src/benchmarks/registry.ts
import type { BenchmarkRunner } from "../schema.js";

const RUNNERS = new Map<string, () => Promise<BenchmarkRunner>>();

export function registerBenchmark(name: string, loader: () => Promise<BenchmarkRunner>): void {
  RUNNERS.set(name, loader);
}

export async function getBenchmark(name: string): Promise<BenchmarkRunner> {
  const loader = RUNNERS.get(name);
  if (!loader) {
    const available = Array.from(RUNNERS.keys()).join(", ");
    throw new Error(`Unknown benchmark "${name}". Available: ${available}`);
  }
  return loader();
}

export function listBenchmarks(): string[] {
  return Array.from(RUNNERS.keys());
}

// Register published benchmarks (lazy-loaded)
registerBenchmark("ama-bench", async () =>
  (await import("./published/ama-bench/runner.js")).amaBenchRunner);
registerBenchmark("memory-arena", async () =>
  (await import("./published/memory-arena/runner.js")).memoryArenaRunner);
registerBenchmark("amemgym", async () =>
  (await import("./published/amemgym/runner.js")).amemGymRunner);
registerBenchmark("longmemeval", async () =>
  (await import("./published/longmemeval/runner.js")).longMemEvalRunner);
registerBenchmark("locomo", async () =>
  (await import("./published/locomo/runner.js")).locomoRunner);
```

- [ ] **Step 3: Commit**

```bash
git add packages/bench/src/benchmarks/
git commit -m "refactor(bench): migrate 5 published benchmark runners into @remnic/bench"
```

---

### Task 1.6: Build the run orchestrator with quick mode

The runner orchestrates benchmark execution: creates adapters, sets up the judge, passes options, collects results, and writes output.

**Files:**
- Create: `packages/bench/src/runner.ts`
- Create: `packages/bench/src/runner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/bench/src/runner.test.ts
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { resolveRunConfig, buildResultMeta } from "./runner.js";

describe("resolveRunConfig", () => {
  it("uses defaults for quick mode", () => {
    const config = resolveRunConfig({ mode: "quick" });
    assert.equal(config.mode, "quick");
    assert.equal(config.runCount, 1);
    assert.deepEqual(config.seeds, [42]);
  });

  it("uses defaults for full mode", () => {
    const config = resolveRunConfig({ mode: "full" });
    assert.equal(config.mode, "full");
    assert.equal(config.runCount, 5);
    assert.equal(config.seeds.length, 5);
  });

  it("respects explicit overrides", () => {
    const config = resolveRunConfig({ mode: "full", runCount: 3, seeds: [1, 2, 3] });
    assert.equal(config.runCount, 3);
    assert.deepEqual(config.seeds, [1, 2, 3]);
  });
});

describe("buildResultMeta", () => {
  it("creates valid metadata", () => {
    const meta = buildResultMeta("longmemeval", "published", { mode: "quick", runCount: 1, seeds: [42] });
    assert.equal(meta.benchmark, "longmemeval");
    assert.equal(meta.benchmarkTier, "published");
    assert.equal(meta.mode, "quick");
    assert.equal(meta.runCount, 1);
    assert.ok(meta.id.length > 0);
    assert.ok(meta.timestamp.length > 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test packages/bench/src/runner.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `packages/bench/src/runner.ts`**

```typescript
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getRemnicVersion, getGitSha, getEnvironment, writeResult, printSummary } from "./reporter.js";
import { getBenchmark, listBenchmarks } from "./benchmarks/registry.js";
import type { BenchmarkResult, BenchmarkResultMeta, ProviderConfig } from "./schema.js";

const DEFAULT_SEEDS = [42, 123, 456, 789, 1024];

export interface RunConfig {
  mode: "full" | "quick";
  runCount: number;
  seeds: number[];
}

export function resolveRunConfig(opts: {
  mode: "full" | "quick";
  runCount?: number;
  seeds?: number[];
}): RunConfig {
  if (opts.mode === "quick") {
    return { mode: "quick", runCount: 1, seeds: [opts.seeds?.[0] ?? 42] };
  }
  const runCount = opts.runCount ?? 5;
  const baseSeed = DEFAULT_SEEDS[0];
  const rawSeeds = opts.seeds
    ?? (runCount <= DEFAULT_SEEDS.length
      ? DEFAULT_SEEDS.slice(0, runCount)
      : Array.from({ length: runCount }, (_, i) => baseSeed + i));
  const seeds = rawSeeds.length >= runCount
    ? rawSeeds.slice(0, runCount)
    : [...rawSeeds, ...Array.from({ length: runCount - rawSeeds.length }, (_, i) => baseSeed + rawSeeds.length + i)];
  return { mode: "full", runCount, seeds };
}

export function buildResultMeta(
  benchmark: string,
  tier: "published" | "remnic" | "custom",
  runConfig: RunConfig,
): BenchmarkResultMeta {
  return {
    id: randomUUID().slice(0, 7),
    benchmark,
    benchmarkTier: tier,
    version: "1.0.0",
    remnicVersion: getRemnicVersion(),
    gitSha: getGitSha(),
    timestamp: new Date().toISOString(),
    mode: runConfig.mode,
    runCount: runConfig.runCount,
    seeds: runConfig.seeds,
  };
}

export interface RunBenchmarkOpts {
  benchmarks: string[];
  mode: "full" | "quick";
  runCount?: number;
  seeds?: number[];
  limit?: number;
  datasetDir?: string;
  outputDir?: string;
  systemProvider?: ProviderConfig;
  judgeProvider?: ProviderConfig;
  json?: boolean;
}

export async function runBenchmarks(opts: RunBenchmarkOpts): Promise<BenchmarkResult[]> {
  const runConfig = resolveRunConfig(opts);
  const defaultResultsDir = path.join(os.homedir(), ".remnic", "bench", "results");
  const outputDir = opts.outputDir ?? defaultResultsDir;
  const defaultDatasets = path.join(os.homedir(), ".remnic", "bench", "datasets");
  const datasetBase = opts.datasetDir ?? defaultDatasets;
  const results: BenchmarkResult[] = [];

  const system = await createDefaultAdapter(opts.systemProvider);
  const judge = opts.judgeProvider
    ? await createProvider(opts.judgeProvider)
    : undefined;

  try {
    for (const name of opts.benchmarks) {
      const runner = await getBenchmark(name);
      console.log(`\nRunning: ${runner.meta.name} (${runner.meta.category})...`);

      for (const seed of runConfig.seeds) {
        const result = await runner.run(
          system,
          {
            limit: opts.limit,
            datasetDir: path.join(datasetBase, name),
            mode: runConfig.mode,
            seed,
            judge,
          },
        );

        const filePath = await writeResult(result, outputDir);
        if (!opts.json) {
          printSummary(result);
          console.log(`Results saved: ${filePath}`);
        }
        results.push(result);
      }
    }

    return results;
  } finally {
    await system.cleanup?.();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test packages/bench/src/runner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/bench/src/runner.ts packages/bench/src/runner.test.ts
git commit -m "feat(bench): add run orchestrator with quick/full mode support"
```

---

### Task 1.7: Wire up the CLI commands

Add `bench run`, `bench list`, and `bench results` commands to the existing `remnic` CLI.

**Files:**
- Create: `packages/bench/src/cli.ts`
- Modify: `packages/remnic-cli/src/index.ts` — update the bench command handler to use new CLI

- [ ] **Step 1: Create `packages/bench/src/cli.ts`**

```typescript
import { listBenchmarks } from "./benchmarks/registry.js";
import { runBenchmarks } from "./runner.js";

export interface BenchCliArgs {
  action: string;
  benchmarks: string[];
  quick: boolean;
  limit?: number;
  datasetDir?: string;
  outputDir?: string;
  configFile?: string;
  json: boolean;
  threshold?: number;
}

export function parseBenchArgs(args: string[]): BenchCliArgs {
  const action = args[0] ?? "help";
  const benchmarks: string[] = [];
  let quick = false;
  let limit: number | undefined;
  let datasetDir: string | undefined;
  let outputDir: string | undefined;
  let configFile: string | undefined;
  let json = false;
  let threshold: number | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--quick") { quick = true; continue; }
    if (arg === "--json") { json = true; continue; }
    if (arg === "--all") { benchmarks.push(...listBenchmarks()); continue; }
    if (arg === "--limit") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--limit requires a value");
      limit = parseInt(args[++i], 10);
      if (Number.isNaN(limit)) throw new Error(`Invalid --limit value: "${args[i]}"`);
      continue;
    }
    if (arg === "--dataset-dir") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--dataset-dir requires a value");
      datasetDir = args[++i]; continue;
    }
    if (arg === "--output-dir") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--output-dir requires a value");
      outputDir = args[++i]; continue;
    }
    if (arg === "--config") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--config requires a value");
      configFile = args[++i]; continue;
    }
    if (arg === "--threshold") {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("--threshold requires a value");
      threshold = parseFloat(args[++i]);
      if (Number.isNaN(threshold)) throw new Error(`Invalid --threshold value: "${args[i]}"`);
      continue;
    }
    if (!arg.startsWith("--")) { benchmarks.push(arg); }
  }

  return { action, benchmarks, quick, limit, datasetDir, outputDir, configFile, json, threshold };
}

export async function handleBenchCommand(args: string[]): Promise<void> {
  const parsed = parseBenchArgs(args);

  switch (parsed.action) {
    case "list": {
      const benchmarks = listBenchmarks();
      if (parsed.json) {
        console.log(JSON.stringify(benchmarks));
      } else {
        console.log("Available benchmarks:");
        for (const b of benchmarks) {
          console.log(`  ${b}`);
        }
      }
      break;
    }

    case "run": {
      if (parsed.benchmarks.length === 0) {
        console.error("ERROR: specify benchmark name(s) or --all. Use 'remnic bench list' to see available.");
        process.exitCode = 1;
        return;
      }
      await runBenchmarks({
        benchmarks: parsed.benchmarks,
        mode: parsed.quick ? "quick" : "full",
        limit: parsed.limit,
        datasetDir: parsed.datasetDir,
        outputDir: parsed.outputDir,
        json: parsed.json,
      });
      break;
    }

    case "help":
    default: {
      console.log(`
Remnic Bench — Benchmark Suite

Usage: remnic bench <command> [options]

Commands:
  run <name...>     Run benchmark(s). Use --all for all.
  list              List available benchmarks
  compare           Compare two runs (Phase 2)
  results           List stored results (Phase 2)
  baseline          Manage baselines (Phase 3)
  export            Export results (Phase 3)
  ui                Start dashboard (Phase 4)
  providers         Discover available LLM providers (Phase 2)

Options:
  --quick           Single run, no statistics (fast feedback)
  --all             Run all benchmarks
  --limit <n>       Max tasks per benchmark
  --config <file>   Config file (bench.config.yaml)
  --output-dir <p>  Results directory
  --json            Machine-parseable output
  --threshold <n>   Regression threshold for compare (default: 0.05)
`);
    }
  }
}
```

- [ ] **Step 2: Update `packages/bench/src/index.ts` barrel exports**

```typescript
// packages/bench/src/index.ts
export * from "./types.js";
export * from "./schema.js";
export * from "./adapters/types.js";
export * from "./providers/types.js";
export * from "./providers/openai.js";
export { listBenchmarks, getBenchmark, registerBenchmark } from "./benchmarks/registry.js";
export { runBenchmarks, resolveRunConfig, buildResultMeta } from "./runner.js";
export { handleBenchCommand, parseBenchArgs } from "./cli.js";
export * from "./scorer.js";
export { writeResult, printSummary, getRemnicVersion, getGitSha } from "./reporter.js";
export {
  runBenchSuite,
  runExplain,
  loadBaseline,
  saveBaseline,
  checkRegression,
  generateReport,
} from "./benchmark.js";
```

- [ ] **Step 3: Update `packages/remnic-cli/src/index.ts` to route `bench` commands to new CLI**

Find the existing `cmdBenchmark` handler (around line 1903) and add a branch that delegates to `handleBenchCommand` for the new subcommands (`run`, `list`, `compare`, etc.), while keeping backward compat for the existing `benchmark run/check/report` commands.

- [ ] **Step 4: Verify `remnic bench list` works**

Run: `npx tsx packages/remnic-cli/src/index.ts bench list`
Expected: Prints 5 benchmark names

- [ ] **Step 5: Commit**

```bash
git add packages/bench/src/cli.ts packages/bench/src/index.ts packages/remnic-cli/src/index.ts
git commit -m "feat(bench): add bench CLI with run and list commands"
```

---

### Task 1.8: End-to-end integration test

Verify that `remnic bench run --quick longmemeval` produces valid results JSON (using the lightweight adapter so no external services are needed).

**Files:**
- Create: `packages/bench/src/__tests__/integration.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// packages/bench/src/__tests__/integration.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBenchArgs } from "../cli.js";
import { resolveRunConfig } from "../runner.js";
import { listBenchmarks, getBenchmark } from "../benchmarks/registry.js";

describe("bench integration", () => {
  it("lists all 5 published benchmarks", () => {
    const benchmarks = listBenchmarks();
    assert.ok(benchmarks.includes("longmemeval"));
    assert.ok(benchmarks.includes("ama-bench"));
    assert.ok(benchmarks.includes("memory-arena"));
    assert.ok(benchmarks.includes("amemgym"));
    assert.ok(benchmarks.includes("locomo"));
    assert.equal(benchmarks.length, 5);
  });

  it("parses --quick flag correctly", () => {
    const args = parseBenchArgs(["run", "--quick", "longmemeval"]);
    assert.equal(args.action, "run");
    assert.equal(args.quick, true);
    assert.deepEqual(args.benchmarks, ["longmemeval"]);
  });

  it("parses --all flag", () => {
    const args = parseBenchArgs(["run", "--all"]);
    assert.equal(args.benchmarks.length, 5);
  });

  it("resolves quick run config", () => {
    const config = resolveRunConfig({ mode: "quick" });
    assert.equal(config.runCount, 1);
    assert.equal(config.seeds[0], 42);
  });

  it("loads a benchmark runner", async () => {
    const runner = await getBenchmark("longmemeval");
    assert.equal(runner.meta.name, "longmemeval");
    assert.ok(typeof runner.run === "function");
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx tsx --test packages/bench/src/__tests__/integration.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/bench/src/__tests__/integration.test.ts
git commit -m "test(bench): add integration tests for bench CLI and runner"
```

---

## Phase 2 — Statistical Rigor + New Benchmarks

Phase 2 adds the statistical engine (bootstrap CIs, effect sizes, paired comparisons), remaining LLM providers (Anthropic, Ollama, LiteLLM with LM Studio discovery), 4 new published benchmark runners, and the comparison command.

### Task 2.1: Implement bootstrap confidence intervals

**Files:**
- Create: `packages/bench/src/stats/bootstrap.ts`
- Create: `packages/bench/src/stats/__tests__/bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/bench/src/stats/__tests__/bootstrap.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bootstrapCI, computeAggregates } from "../bootstrap.js";

describe("bootstrapCI", () => {
  it("computes 95% CI for known distribution", () => {
    const values = [0.5, 0.6, 0.55, 0.62, 0.58, 0.61, 0.54, 0.59, 0.57, 0.56];
    const ci = bootstrapCI(values, { samples: 10000, level: 0.95, seed: 42 });
    assert.ok(ci.lower >= 0.50);
    assert.ok(ci.upper <= 0.65);
    assert.ok(ci.lower < ci.upper);
  });

  it("returns point estimate for single value", () => {
    const ci = bootstrapCI([0.75], { samples: 1000, level: 0.95, seed: 42 });
    assert.equal(ci.lower, 0.75);
    assert.equal(ci.upper, 0.75);
  });
});

describe("computeAggregates", () => {
  it("computes mean, median, stdDev, min, max", () => {
    const values = [1, 2, 3, 4, 5];
    const agg = computeAggregates(values);
    assert.equal(agg.mean, 3);
    assert.equal(agg.median, 3);
    assert.equal(agg.min, 1);
    assert.equal(agg.max, 5);
    assert.ok(Math.abs(agg.stdDev - 1.4142) < 0.01);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test packages/bench/src/stats/__tests__/bootstrap.test.ts`

- [ ] **Step 3: Implement `packages/bench/src/stats/bootstrap.ts`**

```typescript
export interface CIResult {
  lower: number;
  upper: number;
  level: number;
}

export interface AggregateResult {
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0x100000000;
  };
}

export function bootstrapCI(
  values: number[],
  opts: { samples?: number; level?: number; seed?: number } = {},
): CIResult {
  const { samples = 1000, level = 0.95, seed = 42 } = opts;
  if (values.length <= 1) {
    const v = values[0] ?? 0;
    return { lower: v, upper: v, level };
  }

  const rng = seededRandom(seed);
  const means: number[] = [];

  for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) {
      sum += values[Math.floor(rng() * values.length)];
    }
    means.push(sum / values.length);
  }

  means.sort((a, b) => a - b);
  const alpha = 1 - level;
  const lowerIdx = Math.floor((alpha / 2) * means.length);
  const upperIdx = Math.floor((1 - alpha / 2) * means.length) - 1;

  return {
    lower: means[lowerIdx],
    upper: means[Math.min(upperIdx, means.length - 1)],
    level,
  };
}

export function computeAggregates(values: number[]): AggregateResult {
  if (values.length === 0) return { mean: 0, median: 0, stdDev: 0, min: 0, max: 0 };

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  return { mean, median, stdDev, min: sorted[0], max: sorted[sorted.length - 1] };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test packages/bench/src/stats/__tests__/bootstrap.test.ts`

- [ ] **Step 5: Commit**

```bash
git add packages/bench/src/stats/
git commit -m "feat(bench): add bootstrap CI and aggregate computation"
```

---

### Task 2.2: Implement effect sizes and comparison engine

**Files:**
- Create: `packages/bench/src/stats/effect-size.ts`
- Create: `packages/bench/src/stats/comparison.ts`
- Create: `packages/bench/src/stats/__tests__/effect-size.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/bench/src/stats/__tests__/effect-size.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cohensD, interpretEffectSize } from "../effect-size.js";

describe("cohensD", () => {
  it("returns 0 for identical groups", () => {
    const d = cohensD([1, 2, 3], [1, 2, 3]);
    assert.equal(d, 0);
  });

  it("detects large effect", () => {
    const d = cohensD([1, 2, 3], [5, 6, 7]);
    assert.ok(Math.abs(d) > 0.8);
  });

  it("interprets correctly", () => {
    assert.equal(interpretEffectSize(0.1), "negligible");
    assert.equal(interpretEffectSize(0.3), "small");
    assert.equal(interpretEffectSize(0.6), "medium");
    assert.equal(interpretEffectSize(1.0), "large");
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

```typescript
// packages/bench/src/stats/effect-size.ts
export function cohensD(group1: number[], group2: number[]): number {
  if (group1.length === 0 || group2.length === 0) return 0;

  const mean1 = group1.reduce((a, b) => a + b, 0) / group1.length;
  const mean2 = group2.reduce((a, b) => a + b, 0) / group2.length;

  const var1 = group1.reduce((sum, v) => sum + (v - mean1) ** 2, 0) / group1.length;
  const var2 = group2.reduce((sum, v) => sum + (v - mean2) ** 2, 0) / group2.length;

  const pooledStd = Math.sqrt((var1 + var2) / 2);
  if (pooledStd === 0) return 0;

  return (mean1 - mean2) / pooledStd;
}

export function interpretEffectSize(d: number): "negligible" | "small" | "medium" | "large" {
  const abs = Math.abs(d);
  if (abs < 0.2) return "negligible";
  if (abs < 0.5) return "small";
  if (abs < 0.8) return "medium";
  return "large";
}
```

```typescript
// packages/bench/src/stats/comparison.ts
import { bootstrapCI } from "./bootstrap.js";
import { cohensD, interpretEffectSize } from "./effect-size.js";
import type { BenchmarkResult, StatisticalReport } from "../schema.js";

export interface ComparisonResult {
  benchmark: string;
  metricDeltas: Record<string, {
    baseline: number;
    candidate: number;
    delta: number;
    percentChange: number;
    cohensD: number;
    interpretation: "negligible" | "small" | "medium" | "large";
    ciOnDelta?: { lower: number; upper: number };
  }>;
  verdict: "pass" | "regression" | "improvement";
}

export function compareResults(
  baseline: BenchmarkResult,
  candidate: BenchmarkResult,
  threshold: number = 0.05,
): ComparisonResult {
  const metricDeltas: ComparisonResult["metricDeltas"] = {};
  let hasRegression = false;
  let hasImprovement = false;

  const baseMetrics = baseline.results.aggregates;
  const candMetrics = candidate.results.aggregates;

  for (const key of Object.keys(candMetrics)) {
    if (!baseMetrics[key]) continue;
    const bMean = baseMetrics[key].mean;
    const cMean = candMetrics[key].mean;
    const delta = cMean - bMean;
    const percentChange = bMean !== 0
      ? delta / bMean
      : (delta !== 0 ? Infinity * Math.sign(delta) : 0);

    const bScores = baseline.results.tasks.map(t => t.scores[key] ?? 0);
    const cScores = candidate.results.tasks.map(t => t.scores[key] ?? 0);
    const d = cohensD(cScores, bScores);

    if (percentChange < -threshold) hasRegression = true;
    if (percentChange > threshold) hasImprovement = true;

    metricDeltas[key] = {
      baseline: bMean,
      candidate: cMean,
      delta,
      percentChange,
      cohensD: d,
      interpretation: interpretEffectSize(d),
    };
  }

  return {
    benchmark: candidate.meta.benchmark,
    metricDeltas,
    verdict: hasRegression ? "regression" : hasImprovement ? "improvement" : "pass",
  };
}
```

- [ ] **Step 3: Run tests, verify pass, commit**

```bash
git add packages/bench/src/stats/
git commit -m "feat(bench): add effect sizes and comparison engine"
```

---

### Task 2.3: Add Anthropic, Ollama, and LiteLLM providers

**Files:**
- Create: `packages/bench/src/providers/anthropic.ts`
- Create: `packages/bench/src/providers/ollama.ts`
- Create: `packages/bench/src/providers/litellm.ts`
- Create: `packages/bench/src/providers/factory.ts`

- [ ] **Step 1: Implement Anthropic provider**

Same pattern as OpenAI provider but targeting `https://api.anthropic.com/v1/messages` with `x-api-key` header and `anthropic-version` header. Tracks tokens from `usage.input_tokens` and `usage.output_tokens` in the response.

- [ ] **Step 2: Implement Ollama provider**

Target `http://localhost:11434/api/generate`. Implements `discover()` via `http://localhost:11434/api/tags` which returns installed models with parameter sizes.

- [ ] **Step 3: Implement LiteLLM provider**

Thin wrapper around OpenAI-compatible API (LiteLLM proxy exposes `/chat/completions`). Constructor takes `baseUrl` (default `http://localhost:4000`).

- [ ] **Step 4: Create provider factory**

```typescript
// packages/bench/src/providers/factory.ts
import type { LlmProvider } from "./types.js";
import type { ProviderFactoryConfig } from "./types.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { LiteLLMProvider } from "./litellm.js";

export function createProvider(config: ProviderFactoryConfig): LlmProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAIProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    case "ollama":
      return new OllamaProvider(config);
    case "litellm":
      return new LiteLLMProvider(config);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

export async function discoverAllProviders(): Promise<Array<{
  provider: string;
  models: Array<{ id: string; name: string; contextLength: number }>;
}>> {
  const results: Array<{ provider: string; models: any[] }> = [];

  // Try Ollama
  try {
    const ollama = new OllamaProvider({ model: "probe" });
    const models = await ollama.discover!();
    if (models.length > 0) results.push({ provider: "ollama", models });
  } catch { /* not available */ }

  // Try LM Studio (OpenAI-compatible on default port)
  try {
    const lms = new OpenAIProvider({ model: "probe", baseUrl: "http://localhost:1234/v1" });
    const models = await lms.discover!();
    if (models.length > 0) results.push({ provider: "lm-studio", models });
  } catch { /* not available */ }

  return results;
}
```

- [ ] **Step 5: Write tests for each provider, verify, commit**

```bash
git add packages/bench/src/providers/
git commit -m "feat(bench): add Anthropic, Ollama, LiteLLM providers and factory"
```

---

### Task 2.4: Implement BEAM benchmark runner

**Files:**
- Create: `packages/bench/src/benchmarks/published/beam/runner.ts`

- [ ] **Step 1: Research BEAM dataset format**

Download the dataset from HuggingFace (`Mohammadta/BEAM`) and examine the schema. BEAM provides conversations at 128K/500K/1M/10M token scales with 2,000 probing questions across 10 memory abilities.

- [ ] **Step 2: Implement runner following existing pattern**

Follow the same pattern as `longmemeval/runner.ts`: load dataset, ingest via `system.store()`, probe via `system.recall()`, score with `f1Score`, `containsAnswer`, and optionally `llmJudgeScore`. Aggregate per-ability and per-scale.

- [ ] **Step 3: Register in `registry.ts`**

Add: `registerBenchmark("beam", async () => (await import("./published/beam/runner.js")).beamRunner);`

- [ ] **Step 4: Add dataset download to `evals/scripts/download-datasets.sh`**

- [ ] **Step 5: Test, commit**

```bash
git add packages/bench/src/benchmarks/published/beam/ packages/bench/src/benchmarks/registry.ts
git commit -m "feat(bench): add BEAM benchmark runner (10M token scale)"
```

---

### Task 2.5: Implement PersonaMem-v2 benchmark runner

**Files:**
- Create: `packages/bench/src/benchmarks/published/personamem/runner.ts`

- [ ] **Step 1: Research PersonaMem-v2 dataset format from HuggingFace**

- [ ] **Step 2: Implement runner — ingest user-chatbot interactions, probe for implicit preference recall**

- [ ] **Step 3: Register in `registry.ts`, add dataset download, test, commit**

```bash
git commit -m "feat(bench): add PersonaMem-v2 benchmark runner"
```

---

### Task 2.6: Implement MemoryAgentBench runner

**Files:**
- Create: `packages/bench/src/benchmarks/published/memoryagentbench/runner.ts`

- [ ] **Step 1: Research MemoryAgentBench from GitHub (HUST-AI-HYZ/MemoryAgentBench)**

- [ ] **Step 2: Implement runner testing 4 competencies: Accurate Retrieval, Test-Time Learning, Long-Range Understanding, Selective Forgetting**

- [ ] **Step 3: Register, download, test, commit**

```bash
git commit -m "feat(bench): add MemoryAgentBench runner (selective forgetting)"
```

---

### Task 2.7: Implement MemBench runner

**Files:**
- Create: `packages/bench/src/benchmarks/published/membench/runner.ts`

- [ ] **Step 1: Research MemBench from ArXiv 2506.21605**

- [ ] **Step 2: Implement runner testing factual vs reflective memory across participation/observation scenarios**

- [ ] **Step 3: Register, download, test, commit**

```bash
git commit -m "feat(bench): add MemBench runner (factual vs reflective)"
```

---

### Task 2.8: Add `bench compare` CLI command

**Files:**
- Modify: `packages/bench/src/cli.ts` — add `compare` subcommand
- Create: `packages/bench/src/results-store.ts` — load results from disk

- [ ] **Step 1: Implement results store (load results from output directory)**

```typescript
// packages/bench/src/results-store.ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkResult } from "./schema.js";

export async function loadResult(filePath: string): Promise<BenchmarkResult> {
  const content = await readFile(filePath, "utf-8");
  return JSON.parse(content) as BenchmarkResult;
}

export async function listResults(
  outputDir: string,
): Promise<Array<{ id: string; path: string; benchmark: string; timestamp: string; mode: string }>> {
  if (!existsSync(outputDir)) return [];
  const files = await readdir(outputDir);
  const results: Array<{ id: string; path: string; benchmark: string; timestamp: string; mode: string }> = [];

  for (const file of files.filter(f => f.endsWith(".json"))) {
    try {
      const result = await loadResult(path.join(outputDir, file));
      results.push({
        id: result.meta.id,
        path: path.join(outputDir, file),
        benchmark: result.meta.benchmark,
        timestamp: result.meta.timestamp,
        mode: result.meta.mode,
      });
    } catch { /* skip invalid files */ }
  }

  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
```

- [ ] **Step 2: Add `compare` to CLI handler, print comparison table with deltas and effect sizes**

- [ ] **Step 3: Test, commit**

```bash
git add packages/bench/src/results-store.ts packages/bench/src/cli.ts
git commit -m "feat(bench): add bench compare command with effect sizes"
```

---

## Phase 3 — Remnic-Specific Benchmarks + Custom Framework

### Task 3.1: Implement taxonomy accuracy benchmark

**Files:**
- Create: `packages/bench/src/benchmarks/remnic/taxonomy-accuracy/runner.ts`
- Create: `packages/bench/src/benchmarks/remnic/taxonomy-accuracy/dataset.ts`

- [ ] **Step 1: Create synthetic dataset with known MECE categories**

Generate a set of 100+ facts with ground-truth taxonomy classifications. Store as embedded JSON.

- [ ] **Step 2: Implement runner — store facts, verify taxonomy assignment matches expected**

Score: per-category precision, recall, F1. Aggregate: macro-averaged F1.

- [ ] **Step 3: Register, test, commit**

```bash
git commit -m "feat(bench): add taxonomy accuracy benchmark"
```

---

### Task 3.2: Implement entity consolidation benchmark

**Files:**
- Create: `packages/bench/src/benchmarks/remnic/entity-consolidation/runner.ts`

- [ ] **Step 1: Create dataset with duplicate/evolving entity mentions**

E.g., "John Smith", "J. Smith", "John S." all referring to the same entity, plus genuinely different entities with similar names.

- [ ] **Step 2: Implement runner — store mentions across sessions, measure dedup precision/recall**

- [ ] **Step 3: Register, test, commit**

```bash
git commit -m "feat(bench): add entity consolidation benchmark"
```

---

### Task 3.3: Implement extraction judge calibration benchmark

**Files:**
- Create: `packages/bench/src/benchmarks/remnic/extraction-judge-calibration/runner.ts`

- [ ] **Step 1: Create pre-labeled fact set (100+ items, labeled as fact-worthy or not)**

- [ ] **Step 2: Run extraction judge on each, measure sensitivity/specificity**

- [ ] **Step 3: Register, test, commit**

```bash
git commit -m "feat(bench): add extraction judge calibration benchmark"
```

---

### Task 3.4: Implement page versioning benchmark

**Files:**
- Create: `packages/bench/src/benchmarks/remnic/page-versioning/runner.ts`

- [ ] **Step 1: Design write/overwrite sequences that exercise version chain**

- [ ] **Step 2: Verify version list, diff, and revert integrity**

- [ ] **Step 3: Register, test, commit**

```bash
git commit -m "feat(bench): add page versioning benchmark"
```

---

### Task 3.5: Implement enrichment fidelity benchmark

**Files:**
- Create: `packages/bench/src/benchmarks/remnic/enrichment-fidelity/runner.ts`

- [ ] **Step 1: Create known-answer enrichment targets**

- [ ] **Step 2: Measure precision of enrichment output**

- [ ] **Step 3: Register, test, commit**

```bash
git commit -m "feat(bench): add enrichment fidelity benchmark"
```

---

### Task 3.6: Implement custom benchmark YAML loader

**Files:**
- Create: `packages/bench/src/benchmarks/custom/loader.ts`
- Create: `packages/bench/src/benchmarks/custom/__tests__/loader.test.ts`

- [ ] **Step 1: Write failing test for YAML parsing**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCustomBenchmark } from "../loader.js";

describe("parseCustomBenchmark", () => {
  it("parses valid YAML benchmark definition", () => {
    const yaml = `
name: "Test Benchmark"
description: "A test"
tasks:
  - question: "What color is the sky?"
    expected: "blue"
    tags: [nature]
scoring: llm_judge
`;
    const bench = parseCustomBenchmark(yaml);
    assert.equal(bench.name, "Test Benchmark");
    assert.equal(bench.tasks.length, 1);
    assert.equal(bench.tasks[0].question, "What color is the sky?");
    assert.equal(bench.scoring, "llm_judge");
  });

  it("rejects benchmark with no tasks", () => {
    const yaml = `name: "Empty"\ntasks: []\nscoring: f1`;
    assert.throws(() => parseCustomBenchmark(yaml), /at least one task/);
  });
});
```

- [ ] **Step 2: Implement loader using `yaml` npm package**

Parse YAML, validate required fields (`name`, `tasks[]` with `question` + `expected`, `scoring`), return a `BenchmarkRunner` that uses the standard scoring functions.

- [ ] **Step 3: Add `--custom` flag support to CLI**

- [ ] **Step 4: Test, commit**

```bash
git commit -m "feat(bench): add custom YAML benchmark loader"
```

---

### Task 3.7: Add baseline management and export commands

**Files:**
- Modify: `packages/bench/src/cli.ts` — add `baseline save/list`, `export`, `results`
- Create: `packages/bench/src/baseline.ts`

- [ ] **Step 1: Implement baseline save/load**

```typescript
// packages/bench/src/baseline.ts
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { BenchmarkResult } from "./schema.js";

const DEFAULT_BASELINE_DIR = path.join(os.homedir(), ".remnic", "bench", "baselines");

export async function saveBaseline(
  name: string,
  results: BenchmarkResult[],
  dir: string = DEFAULT_BASELINE_DIR,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const safeName = path.basename(name).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safeName) throw new Error(`Invalid baseline name: "${name}"`);
  const filePath = path.join(dir, `${safeName}.json`);
  await writeFile(filePath, JSON.stringify({ name: safeName, timestamp: new Date().toISOString(), results }, null, 2));
  return filePath;
}

export async function loadBaseline(
  name: string,
  dir: string = DEFAULT_BASELINE_DIR,
): Promise<{ name: string; timestamp: string; results: BenchmarkResult[] }> {
  const safeName = path.basename(name).replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!safeName) throw new Error(`Invalid baseline name: "${name}"`);
  const filePath = path.join(dir, `${safeName}.json`);
  return JSON.parse(await readFile(filePath, "utf-8"));
}

export async function listBaselines(
  dir: string = DEFAULT_BASELINE_DIR,
): Promise<string[]> {
  try {
    const files = await readdir(dir);
    return files.filter(f => f.endsWith(".json")).map(f => f.replace(".json", ""));
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Add export command (JSON, CSV)**

- [ ] **Step 3: Wire into CLI, test, commit**

```bash
git commit -m "feat(bench): add baseline management and export commands"
```

---

### Task 3.8: Update CI gate

**Files:**
- Modify: `.github/workflows/eval-benchmark-gate.yml`

- [ ] **Step 1: Update CI workflow to use new `remnic bench compare --baseline` command**

- [ ] **Step 2: Commit**

```bash
git commit -m "ci(bench): update benchmark gate to use new bench CLI"
```

---

## Phase 4 — Dashboard & Publishing

### Task 4.1: Scaffold `@remnic/bench-ui` package

**Files:**
- Create: `packages/bench-ui/package.json`
- Create: `packages/bench-ui/tsconfig.json`
- Create: `packages/bench-ui/vite.config.ts`
- Create: `packages/bench-ui/tailwind.config.ts`
- Create: `packages/bench-ui/index.html`
- Create: `packages/bench-ui/src/main.tsx`
- Create: `packages/bench-ui/src/App.tsx`

- [ ] **Step 1: Create `packages/bench-ui/package.json`**

```json
{
  "name": "@remnic/bench-ui",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@remnic/bench": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "recharts": "^2.15.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.9.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 2: Create Vite + Tailwind config**

- [ ] **Step 3: Create `App.tsx` with router skeleton**

```tsx
// packages/bench-ui/src/App.tsx
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { Overview } from "./pages/Overview.js";
import { Runs } from "./pages/Runs.js";
import { Compare } from "./pages/Compare.js";
import { BenchmarkDetail } from "./pages/BenchmarkDetail.js";
import { Providers } from "./pages/Providers.js";

export function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen bg-gray-50">
        <nav className="w-52 bg-gray-900 text-gray-400 p-4 flex-shrink-0">
          <h1 className="text-white font-semibold text-lg mb-6">Remnic Bench</h1>
          <div className="space-y-1">
            <NavLink to="/" className={({ isActive }) =>
              `block px-3 py-2 rounded-md text-sm ${isActive ? "bg-gray-800 text-white" : "hover:text-white"}`
            }>Overview</NavLink>
            <NavLink to="/runs" className={({ isActive }) =>
              `block px-3 py-2 rounded-md text-sm ${isActive ? "bg-gray-800 text-white" : "hover:text-white"}`
            }>Runs</NavLink>
            <NavLink to="/compare" className={({ isActive }) =>
              `block px-3 py-2 rounded-md text-sm ${isActive ? "bg-gray-800 text-white" : "hover:text-white"}`
            }>Compare</NavLink>
            <NavLink to="/providers" className={({ isActive }) =>
              `block px-3 py-2 rounded-md text-sm ${isActive ? "bg-gray-800 text-white" : "hover:text-white"}`
            }>Providers</NavLink>
          </div>
        </nav>
        <main className="flex-1 overflow-auto p-6">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/compare" element={<Compare />} />
            <Route path="/benchmark/:name" element={<BenchmarkDetail />} />
            <Route path="/providers" element={<Providers />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
```

- [ ] **Step 4: Verify `npm run dev` starts, commit**

```bash
git add packages/bench-ui/
git commit -m "feat(bench-ui): scaffold React + Tailwind dashboard package"
```

---

### Task 4.2: Build Overview page

**Files:**
- Create: `packages/bench-ui/src/pages/Overview.tsx`
- Create: `packages/bench-ui/src/components/ScoreCard.tsx`
- Create: `packages/bench-ui/src/components/TrendChart.tsx`
- Create: `packages/bench-ui/src/components/RunTable.tsx`
- Create: `packages/bench-ui/src/lib/data.ts`

- [ ] **Step 1: Implement data loader via Vite dev server API proxy**

The React app cannot read the local filesystem directly. During `vite dev`, a small server middleware (Vite plugin) exposes `GET /api/results` which reads `~/.remnic/bench/results/*.json` and returns them as a JSON array. For the static HTML export, the CLI pre-bundles the data as an inlined JSON blob at build time.

- [ ] **Step 2: Build ScoreCard component (benchmark name, score, delta, CI)**

- [ ] **Step 3: Build TrendChart with Recharts (score over time, 7d/30d/90d/all toggle)**

- [ ] **Step 4: Build RunTable (ID, benchmark, mode badge, system/judge, score, delta, cost)**

- [ ] **Step 5: Assemble Overview page, verify in browser, commit**

```bash
git commit -m "feat(bench-ui): build Overview page with score cards, trend chart, run table"
```

---

### Task 4.3: Build Runs, Compare, BenchmarkDetail, and Providers pages

**Files:**
- Create: `packages/bench-ui/src/pages/Runs.tsx`
- Create: `packages/bench-ui/src/pages/Compare.tsx`
- Create: `packages/bench-ui/src/pages/BenchmarkDetail.tsx`
- Create: `packages/bench-ui/src/pages/Providers.tsx`
- Create: `packages/bench-ui/src/components/ComparisonTable.tsx`
- Create: `packages/bench-ui/src/components/TaskBreakdown.tsx`
- Create: `packages/bench-ui/src/components/CostSummary.tsx`

- [ ] **Step 1: Build Runs page — filterable table with all run history**

- [ ] **Step 2: Build Compare page — select two runs, show paired deltas, CIs, effect sizes**

- [ ] **Step 3: Build BenchmarkDetail page — per-task score breakdown, score distribution histogram**

- [ ] **Step 4: Build Providers page — matrix of providers × benchmarks × scores**

- [ ] **Step 5: Verify all pages render with real results data, commit**

```bash
git commit -m "feat(bench-ui): build Runs, Compare, BenchmarkDetail, Providers pages"
```

---

### Task 4.4: Static HTML export

**Files:**
- Create: `packages/bench-ui/src/lib/export.ts`
- Modify: `packages/bench/src/cli.ts` — add `export --format html`

- [ ] **Step 1: Implement HTML export that bundles results data + minimal React rendering into a single self-contained file**

Use Vite's `build` with inline mode, or generate a standalone HTML with embedded JSON + Tailwind CDN + lightweight chart rendering.

- [ ] **Step 2: Wire into CLI `bench export --format html --output report.html`**

- [ ] **Step 3: Verify exported HTML opens in browser with correct data, commit**

```bash
git commit -m "feat(bench): add static HTML export for benchmark reports"
```

---

### Task 4.5: Remnic.ai JSON feed and `bench publish` command

**Files:**
- Create: `packages/bench-ui/src/lib/publish.ts`
- Modify: `packages/bench/src/cli.ts` — add `publish` subcommand

- [ ] **Step 1: Implement JSON feed generator**

Aggregate latest results per benchmark into a single `benchmarks.json` with schema suitable for Astro consumption.

- [ ] **Step 2: Add `bench publish --target remnic-ai` command**

Writes to `~/.remnic/published/benchmarks.json` or syncs to a configurable path.

- [ ] **Step 3: Test, commit**

```bash
git commit -m "feat(bench): add bench publish command for Remnic.ai integration"
```

---

### Task 4.6: Wire `remnic bench ui` command

**Files:**
- Modify: `packages/bench/src/cli.ts` — add `ui` subcommand
- Create: `packages/bench-ui/src/server.ts`

- [ ] **Step 1: Create server that builds and serves the dashboard**

```typescript
// packages/bench-ui/src/server.ts
import { createServer } from "vite";
import path from "node:path";

export async function startDashboard(port: number = 4200): Promise<void> {
  const server = await createServer({
    root: path.resolve(import.meta.dirname, ".."),
    server: { port, open: true },
  });
  await server.listen();
  console.log(`Remnic Bench UI: http://localhost:${port}`);
}
```

- [ ] **Step 2: Wire CLI to call `startDashboard()`**

- [ ] **Step 3: Verify `remnic bench ui` opens dashboard, commit**

```bash
git commit -m "feat(bench): wire remnic bench ui command to dashboard server"
```

---

## Phase 5 — Remnic.ai Integration

This phase happens in the `~/src/remnic.ai` Astro repo, not in the Remnic monorepo.

### Task 5.1: Create benchmarks page in Astro site

**Files:**
- Create: `src/pages/benchmarks.astro`
- Create: `src/components/BenchmarkLeaderboard.astro`

- [ ] **Step 1: Create page that fetches `benchmarks.json` at build time**

- [ ] **Step 2: Build leaderboard component showing Remnic scores vs published baselines**

- [ ] **Step 3: Add to site navigation, verify, commit**

```bash
git commit -m "feat: add benchmarks page with Remnic leaderboard"
```

---

### Task 5.2: Set up CI auto-publish

**Files:**
- Create: `.github/workflows/publish-benchmarks.yml` (in remnic monorepo)

- [ ] **Step 1: Create workflow that runs `remnic bench publish --target remnic-ai` on main pushes**

- [ ] **Step 2: Trigger Astro site rebuild via webhook or repository dispatch**

- [ ] **Step 3: Test end-to-end flow, commit**

```bash
git commit -m "ci: auto-publish benchmark results to Remnic.ai"
```

---

## Post-Implementation: Create GitHub Issue

After Phase 1 is complete (or when GitHub rate limit resets), create the GitHub issue using the saved body:

```bash
cat docs/superpowers/specs/2026-04-17-bench-suite-github-issue.md | gh issue create \
  --title "Comprehensive Benchmarking & Evaluation Suite" \
  --body-file docs/superpowers/specs/2026-04-17-bench-suite-github-issue.md
```
