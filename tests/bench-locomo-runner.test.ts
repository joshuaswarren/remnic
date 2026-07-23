import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type {
  BenchMemoryAdapter,
  Message,
  SearchResult,
} from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

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

  async search(
    query: string,
    limit: number,
    sessionId?: string,
  ): Promise<SearchResult[]> {
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

  async getStats(): Promise<{
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

function createDatasetConversation() {
  return [
    {
      sample_id: "locomo-dataset-1",
      conversation: {
        speaker_a: "Jordan",
        speaker_b: "Assistant",
        session_1: [
          {
            speaker: "Jordan",
            dia_id: "D1:1",
            text: "I moved to Austin in January for the new project.",
          },
          {
            speaker: "Assistant",
            dia_id: "D1:2",
            text: "Austin in January. I'll keep that in mind.",
          },
        ],
      },
      qa: [
        {
          question: "Which city did Jordan move to?",
          answer: "Austin",
          evidence: ["D1:1"],
          category: 1,
        },
      ],
    },
  ];
}

test("runBenchmark executes locomo in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("locomo", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "locomo");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.statistics, undefined);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(typeof result.results.aggregates.rouge_l?.mean, "number");
  assert.equal(result.results.tasks[0]?.expected, "Seattle");
  assert.equal(result.results.tasks[0]?.actual.includes("Seattle"), true);
  assert.equal(result.results.tasks[0]?.details?.categoryName, "single_hop");
});

test("runBenchmark executes locomo in full mode from an explicit dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-locomo-full-"));
  const datasetDir = path.join(tmpDir, "datasets", "locomo");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "locomo10.json"),
    JSON.stringify(createDatasetConversation()),
    "utf8",
  );

  const result = await runBenchmark("locomo", {
    mode: "full",
    datasetDir,
    system: adapter,
  });

  assert.equal(result.results.tasks.length, 1);
  assert.equal(result.results.tasks[0]?.expected, "Austin");
});

test("runBenchmark rejects locomo full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("locomo", {
        mode: "full",
        system: adapter,
      }),
    /LoCoMo full mode requires datasetDir/,
  );
});

test("runBenchmark fails fast when locomo full mode is given an explicit missing datasetDir", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-locomo-missing-"));
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("locomo", {
        mode: "full",
        datasetDir: path.join(tmpDir, "does-not-exist"),
        system: adapter,
      }),
    /LoCoMo dataset not found under/,
  );
});

test("runBenchmark fails fast when locomo full mode is given an explicit unreadable dataset file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-locomo-bad-"));
  const datasetDir = path.join(tmpDir, "datasets", "locomo");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "locomo10.json"), "{not json");

  await assert.rejects(
    () =>
      runBenchmark("locomo", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /LoCoMo dataset not found under/,
  );
});

test("runBenchmark rejects empty locomo datasets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-locomo-empty-"));
  const datasetDir = path.join(tmpDir, "datasets", "locomo");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "locomo10.json"), "[]", "utf8");

  await assert.rejects(
    () =>
      runBenchmark("locomo", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /LoCoMo dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark treats locomo limit zero as an empty run instead of falling back to all conversations", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("locomo", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /LoCoMo dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark reports locomo qa validation errors with zero-based indices", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-locomo-qa-index-"));
  const datasetDir = path.join(tmpDir, "datasets", "locomo");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "locomo10.json"),
    JSON.stringify([
      {
        sample_id: "locomo-dataset-1",
        conversation: {
          speaker_a: "Jordan",
          speaker_b: "Assistant",
          session_1: [],
        },
        qa: [null],
      },
    ]),
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("locomo", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /qa\[0\] must be an object/,
  );
});
