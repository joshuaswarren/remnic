import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  runBenchmark,
  writeBenchmarkResult,
  type BenchMemoryAdapter,
  type BenchmarkResult,
  type Message,
  type SearchResult,
} from "../packages/bench/src/index.js";

class FakeMemoryAdapter implements BenchMemoryAdapter {
  readonly sessions = new Map<string, Message[]>();

  async store(sessionId: string, messages: Message[]): Promise<void> {
    const existing = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, [...existing, ...messages]);
  }

  async recall(sessionId: string, _query: string): Promise<string> {
    return (this.sessions.get(sessionId) ?? [])
      .map((message) => message.content)
      .join("\n");
  }

  async search(query: string, limit: number, sessionId?: string): Promise<SearchResult[]> {
    const haystack = sessionId
      ? [[sessionId, this.sessions.get(sessionId) ?? []] as const]
      : [...this.sessions.entries()];

    const results: SearchResult[] = [];
    for (const [currentSessionId, messages] of haystack) {
      messages.forEach((message, index) => {
        if (message.content.toLowerCase().includes(query.toLowerCase())) {
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

  async getStats(): Promise<{ totalMessages: number; totalSummaryNodes: number; maxDepth: number }> {
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

test("FakeMemoryAdapter.store appends messages for the same session", async () => {
  const adapter = new FakeMemoryAdapter();

  await adapter.store("session-1", [{ role: "user", content: "first" }]);
  await adapter.store("session-1", [{ role: "assistant", content: "second" }]);

  assert.equal(await adapter.recall("session-1", "ignored"), "first\nsecond");
});

test("runBenchmark executes longmemeval in quick mode and writes a result JSON file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-longmemeval-"));
  const outputDir = path.join(tmpDir, "results");

  const adapter = new FakeMemoryAdapter();
  const result = await runBenchmark("longmemeval", {
    mode: "quick",
    outputDir,
    limit: 1,
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "longmemeval");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.runCount, 1);
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.statistics, undefined);
  assert.equal(result.results.tasks[0]?.actual.includes("Paris"), true);
  assert.equal(result.results.tasks[0]?.expected, "Paris");
  assert.equal(result.results.tasks[0]?.scores.contains_answer, 1);

  const writtenPath = await writeBenchmarkResult(result, outputDir);
  const written = JSON.parse(await readFile(writtenPath, "utf8")) as typeof result;

  assert.equal(path.dirname(writtenPath), outputDir);
  assert.equal(written.meta.benchmark, "longmemeval");
  assert.equal(written.results.tasks.length, 1);
});

test("runBenchmark fails fast when full mode is given an explicit missing datasetDir", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-longmemeval-missing-"));
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("longmemeval", {
        mode: "full",
        datasetDir: path.join(tmpDir, "does-not-exist"),
        system: adapter,
      }),
    /LongMemEval dataset not found under/,
  );
});

test("runBenchmark rejects full mode when no datasetDir is provided", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("longmemeval", {
        mode: "full",
        system: adapter,
      }),
    /LongMemEval full mode requires datasetDir/,
  );
});

test("runBenchmark fails fast when full mode is given an explicit unreadable dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-longmemeval-bad-"));
  const datasetDir = path.join(tmpDir, "datasets");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "longmemeval_oracle.json"), "{not json");

  await assert.rejects(
    () =>
      runBenchmark("longmemeval", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /LongMemEval dataset not found under/,
  );
});

test("runBenchmark rejects zero-task datasets after applying limit", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-longmemeval-empty-"));
  const datasetDir = path.join(tmpDir, "datasets");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "longmemeval_oracle.json"), "[]");

  await assert.rejects(
    () =>
      runBenchmark("longmemeval", {
        mode: "full",
        datasetDir,
        limit: 0,
        system: adapter,
      }),
    /LongMemEval dataset is empty after applying the requested limit/,
  );
});

test("writeBenchmarkResult sanitizes remnicVersion and preserves millisecond precision in filenames", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-reporter-"));
  const outputDir = path.join(tmpDir, "results");
  const result: BenchmarkResult = {
    meta: {
      id: "bench-1",
      benchmark: "longmemeval",
      benchmarkTier: "published",
      version: "1.0.0",
      remnicVersion: "1.2.3/rc:build +meta",
      gitSha: "abc1234",
      timestamp: "2026-04-18T12:34:56.789Z",
      mode: "quick",
      runCount: 1,
      seeds: [1],
    },
    config: {
      systemProvider: null,
      judgeProvider: null,
      adapterMode: "test",
      remnicConfig: {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs: 0,
      meanQueryLatencyMs: 0,
    },
    results: {
      tasks: [],
      aggregates: {},
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
    },
  };

  const writtenPathA = await writeBenchmarkResult(result, outputDir);
  const writtenA = JSON.parse(await readFile(writtenPathA, "utf8")) as BenchmarkResult;
  const writtenPathB = await writeBenchmarkResult(
    {
      ...result,
      meta: {
        ...result.meta,
        id: "bench-2",
        timestamp: "2026-04-18T12:34:56.123Z",
      },
    },
    outputDir,
  );

  assert.equal(
    path.basename(writtenPathA),
    "longmemeval-v1.2.3_rc_build__meta-2026-04-18T12-34-56-789Z.json",
  );
  assert.equal(
    path.basename(writtenPathB),
    "longmemeval-v1.2.3_rc_build__meta-2026-04-18T12-34-56-123Z.json",
  );
  assert.notEqual(writtenPathA, writtenPathB);
  assert.equal(writtenA.meta.remnicVersion, "1.2.3/rc:build +meta");
});
