import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  BenchJudge,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import {
  parseCustomBenchmark,
} from "../packages/bench/src/benchmarks/custom/loader.js";
import { runCustomBenchmarkFile } from "../packages/bench/src/benchmarks/custom/runner.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();
  judge?: BenchJudge;

  async store(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, [...existing, ...messages]);
  }

  async recall(
    sessionId: string,
    _query: string,
    _budgetChars?: number,
  ): Promise<string> {
    return (this.sessions.get(sessionId) ?? [])
      .map((message) => message.content)
      .join("\n");
  }

  async search(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<SearchResult[]> {
    const haystack = sessionId
      ? [[sessionId, this.sessions.get(sessionId) ?? []] as const]
      : [...this.sessions.entries()];
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 2);

    const results: SearchResult[] = [];
    for (const [currentSessionId, messages] of haystack) {
      messages.forEach((message, index) => {
        const content = message.content.toLowerCase();
        if (tokens.some((token) => content.includes(token))) {
          results.push({
            turnIndex: index,
            role: message.role,
            snippet: message.content,
            sessionId: currentSessionId,
            score: 1,
          });
        }
      });
    }

    return results.slice(0, limit);
  }

  async reset(sessionId?: string): Promise<void> {
    if (sessionId) {
      this.sessions.delete(sessionId);
      return;
    }
    this.sessions.clear();
  }

  async getStats(_sessionId?: string): Promise<{
    totalMessages: number;
    totalSummaryNodes: number;
    maxDepth: number;
  }> {
    const totalMessages = [...this.sessions.values()].reduce(
      (sum, messages) => sum + messages.length,
      0,
    );

    return {
      totalMessages,
      totalSummaryNodes: 0,
      maxDepth: 1,
    };
  }

  async destroy(): Promise<void> {}
}

test("parseCustomBenchmark normalizes a valid YAML benchmark definition", () => {
  const benchmark = parseCustomBenchmark(`
name: Sky Check
description: Custom benchmark for a single memory fact
version: 2.0.0
category: retrieval
scoring: exact_match
tasks:
  - question: What color is the sky?
    expected: The sky is blue.
    tags: [nature, weather]
`);

  assert.equal(benchmark.name, "Sky Check");
  assert.equal(benchmark.description, "Custom benchmark for a single memory fact");
  assert.equal(benchmark.version, "2.0.0");
  assert.equal(benchmark.category, "retrieval");
  assert.equal(benchmark.scoring, "exact_match");
  assert.equal(benchmark.tasks.length, 1);
  assert.deepEqual(benchmark.tasks[0]?.tags, ["nature", "weather"]);
});

test("parseCustomBenchmark rejects custom benchmarks without tasks", () => {
  assert.throws(
    () =>
      parseCustomBenchmark(`
name: Empty
scoring: f1
tasks: []
`),
    /must include at least one task/,
  );
});

test("parseCustomBenchmark accepts ingestion as a category", () => {
  const benchmark = parseCustomBenchmark(`
name: Ingestion Check
scoring: exact_match
category: ingestion
tasks:
  - question: Was the document indexed?
    expected: Yes
`);

  assert.equal(benchmark.category, "ingestion");
});

test("parseCustomBenchmark rejects unsupported scoring values", () => {
  assert.throws(
    () =>
      parseCustomBenchmark(`
name: Invalid
scoring: made_up
tasks:
  - question: What is stored here?
    expected: A fact
`),
    /must be one of exact_match, f1, rouge_l, llm_judge/,
  );
});

test("runCustomBenchmarkFile executes a custom YAML benchmark against the adapter", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-custom-bench-"));
  const filePath = path.join(tmpDir, "sky-check.yaml");
  await writeFile(
    filePath,
    `
name: Sky Check
description: Custom benchmark for a single memory fact
scoring: exact_match
tasks:
  - question: What color is the sky?
    expected: The sky is blue.
    tags: [nature, weather]
`,
  );

  const adapter = new FakeMemoryAdapter();
  await adapter.store("memory", [
    { role: "assistant", content: "The sky is blue." },
  ]);

  const result = await runCustomBenchmarkFile(filePath, {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "custom:sky-check");
  assert.equal(result.meta.benchmarkTier, "custom");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.runCount, 1);
  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.actual, "The sky is blue.");
  assert.equal(result.results.tasks[0]?.scores.exact_match, 1);
  assert.equal(result.results.aggregates.exact_match?.mean, 1);
});

test("runCustomBenchmarkFile includes judge token and latency usage for llm_judge scoring", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-custom-bench-judge-"));
  const filePath = path.join(tmpDir, "judge-check.yaml");
  await writeFile(
    filePath,
    `
name: Judge Check
description: Custom benchmark with llm_judge scoring
scoring: llm_judge
tasks:
  - question: What color is the sky?
    expected: The sky is blue.
`,
  );

  const adapter = new FakeMemoryAdapter();
  adapter.judge = {
    async score() {
      return 0.9;
    },
    async scoreWithMetrics() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        score: 0.9,
        tokens: { input: 11, output: 7 },
        latencyMs: 25,
        model: "gpt-5.4-mini",
      };
    },
  };
  await adapter.store("memory", [
    { role: "assistant", content: "The sky is blue." },
  ]);

  const result = await runCustomBenchmarkFile(filePath, {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.results.tasks[0]?.scores.llm_judge, 0.9);
  assert.deepEqual(result.results.tasks[0]?.tokens, { input: 11, output: 7 });
  assert.equal((result.results.tasks[0]?.latencyMs ?? 0) >= 20, true);
  assert.equal(result.results.tasks[0]?.details?.judgeModel, "gpt-5.4-mini");
  assert.equal(result.cost.inputTokens, 11);
  assert.equal(result.cost.outputTokens, 7);
  assert.equal(result.cost.totalTokens, 18);
  assert.equal(result.cost.totalLatencyMs >= 20, true);
  assert.equal(result.cost.meanQueryLatencyMs >= 20, true);
});

test("runCustomBenchmarkFile emits progress callbacks after each completed task", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-custom-bench-progress-"));
  const filePath = path.join(tmpDir, "progress-check.yaml");
  await writeFile(
    filePath,
    `
name: Progress Check
scoring: exact_match
tasks:
  - question: What is alphakey?
    expected: alphakey
  - question: What is betakey?
    expected: betakey
`,
  );

  const adapter = new FakeMemoryAdapter();
  await adapter.store("memory", [
    { role: "assistant", content: "alphakey" },
    { role: "assistant", content: "betakey" },
  ]);

  const progressEvents: Array<{
    completed: number;
    total: number | undefined;
    taskId: string;
    actual: string;
  }> = [];
  const result = await runCustomBenchmarkFile(filePath, {
    mode: "quick",
    system: adapter,
    onTaskComplete(task, completed, total) {
      progressEvents.push({
        completed,
        total,
        taskId: task.taskId,
        actual: task.actual,
      });
    },
  });

  assert.equal(result.results.tasks.length, 2);
  assert.deepEqual(
    progressEvents.map((event) => event.completed),
    [1, 2],
  );
  assert.deepEqual(
    progressEvents.map((event) => event.total),
    [2, 2],
  );
  assert.deepEqual(
    progressEvents.map((event) => event.actual),
    ["alphakey", "betakey"],
  );
  assert.deepEqual(
    progressEvents.map((event) => event.taskId),
    ["progress-check-1-1", "progress-check-1-2"],
  );

  const fullProgressEvents: Array<{
    completed: number;
    total: number | undefined;
  }> = [];
  const fullResult = await runCustomBenchmarkFile(filePath, {
    mode: "full",
    system: adapter,
    onTaskComplete(_task, completed, total) {
      fullProgressEvents.push({ completed, total });
    },
  });
  const fullTotal = fullResult.meta.runCount * 2;

  assert.equal(fullProgressEvents.length, fullTotal);
  assert.deepEqual(
    fullProgressEvents.map((event) => event.completed),
    Array.from({ length: fullTotal }, (_value, index) => index + 1),
  );
  assert.deepEqual(
    fullProgressEvents.map((event) => event.total),
    Array.from({ length: fullTotal }, () => fullTotal),
  );
});
