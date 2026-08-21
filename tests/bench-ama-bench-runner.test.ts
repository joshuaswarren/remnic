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

class SlowRecallMemoryAdapter extends FakeMemoryAdapter {
  activeRecalls = 0;
  maxActiveRecalls = 0;

  async recall(sessionId: string, query: string): Promise<string> {
    this.activeRecalls += 1;
    this.maxActiveRecalls = Math.max(this.maxActiveRecalls, this.activeRecalls);
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      return await super.recall(sessionId, query);
    } finally {
      this.activeRecalls -= 1;
    }
  }
}

class StuckDrainMemoryAdapter extends FakeMemoryAdapter {
  async drain(): Promise<void> {
    return new Promise<void>(() => {});
  }
}

test("runBenchmark executes ama-bench in quick mode through the phase-1 package API", async () => {
  const adapter = new FakeMemoryAdapter();

  const result = await runBenchmark("ama-bench", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "ama-bench");
  assert.equal(result.meta.mode, "quick");
  assert.equal(result.meta.benchmarkTier, "published");
  assert.equal(result.results.tasks.length, 2);
  assert.equal(result.results.statistics, undefined);
  assert.equal(typeof result.results.aggregates.f1?.mean, "number");
  assert.equal(typeof result.results.aggregates.contains_answer?.mean, "number");
  assert.equal(
    result.results.tasks[0]?.actual.includes("preferred language is Spanish"),
    true,
  );
  assert.equal(result.results.tasks[0]?.expected, "Spanish");
  assert.equal(result.results.tasks[0]?.details?.task, "Web task smoke fixture");
  assert.equal(result.results.tasks[0]?.details?.taskType, "web");
  assert.equal(result.results.tasks[0]?.details?.qaType, "recall");
});

test("runBenchmark rejects ama-bench full mode without datasetDir", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("ama-bench", {
        mode: "full",
        system: adapter,
      }),
    /AMA-Bench full mode requires datasetDir/,
  );
});

test("runBenchmark fails fast when ama-bench full mode is given an explicit missing datasetDir", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ama-missing-"));
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("ama-bench", {
        mode: "full",
        datasetDir: path.join(tmpDir, "does-not-exist"),
        system: adapter,
      }),
    /AMA-Bench dataset not found at/,
  );
});

test("runBenchmark fails fast when ama-bench full mode is given malformed JSON", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ama-bad-"));
  const datasetDir = path.join(tmpDir, "datasets", "ama-bench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "open_end_qa_set.jsonl"), "{not json");

  await assert.rejects(
    () =>
      runBenchmark("ama-bench", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /AMA-Bench dataset contains invalid JSON on line 1/,
  );
});

test("runBenchmark rejects empty ama-bench datasets", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ama-empty-"));
  const datasetDir = path.join(tmpDir, "datasets", "ama-bench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(path.join(datasetDir, "open_end_qa_set.jsonl"), "");

  await assert.rejects(
    () =>
      runBenchmark("ama-bench", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /AMA-Bench dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark treats ama-bench limit zero as an empty run instead of falling back to all episodes", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("ama-bench", {
        mode: "quick",
        limit: 0,
        system: adapter,
      }),
    /AMA-Bench dataset is empty after applying the requested limit/,
  );
});

test("runBenchmark applies AMA-Bench trialConcurrency without reordering tasks", async () => {
  const adapter = new SlowRecallMemoryAdapter();

  const result = await runBenchmark("ama-bench", {
    mode: "quick",
    system: adapter,
    benchmarkOptions: { trialConcurrency: 2 },
  });

  assert.equal(adapter.maxActiveRecalls, 2);
  assert.equal(result.config.benchmarkOptions?.trialConcurrency, 2);
  assert.deepEqual(
    result.results.tasks.map((task) => task.taskId),
    ["ama-smoke-q1", "ama-smoke-q2"],
  );
});

test("runBenchmark honors AMA-Bench drainTimeoutMs without a phase timeout", async () => {
  const adapter = new StuckDrainMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("ama-bench", {
        mode: "quick",
        system: adapter,
        drainTimeoutMs: 5,
      }),
    /benchmark phase timed out after 5ms: ama-bench:drain/,
  );
});

test("runBenchmark rejects invalid AMA-Bench trialConcurrency", async () => {
  const adapter = new FakeMemoryAdapter();

  await assert.rejects(
    () =>
      runBenchmark("ama-bench", {
        mode: "quick",
        system: adapter,
        benchmarkOptions: { trialConcurrency: 0 },
      }),
    /AMA-Bench benchmarkOptions\.trialConcurrency must be an integer from 1 to 64/,
  );
});

test("runBenchmark rejects malformed ama-bench trajectory rows with a benchmark-specific error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ama-bad-trajectory-"));
  const datasetDir = path.join(tmpDir, "datasets", "ama-bench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "open_end_qa_set.jsonl"),
    `${JSON.stringify({
      episode_id: 1,
      task: "Broken episode",
      task_type: "web",
      domain: "WEB",
      success: true,
      num_turns: 1,
      total_tokens: 10,
      trajectory: [{ turn_idx: 1, action: "Open the page." }],
      qa_pairs: [
        {
          question: "What happened?",
          answer: "Nothing",
          type: "recall",
          question_uuid: "ama-bad-q1",
        },
      ],
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("ama-bench", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /must include a trajectory array with action\/observation turns/,
  );
});

test("runBenchmark rejects malformed ama-bench qa_pairs with a benchmark-specific error", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-ama-bad-qa-"));
  const datasetDir = path.join(tmpDir, "datasets", "ama-bench");
  const adapter = new FakeMemoryAdapter();
  await mkdir(datasetDir, { recursive: true });
  await writeFile(
    path.join(datasetDir, "open_end_qa_set.jsonl"),
    `${JSON.stringify({
      episode_id: 1,
      task: "Broken episode",
      task_type: "web",
      domain: "WEB",
      success: true,
      num_turns: 1,
      total_tokens: 10,
      trajectory: [
        {
          turn_idx: 1,
          action: "Open the page.",
          observation: "The profile shows the user's preferred language is Spanish.",
        },
      ],
      qa_pairs: [{ question: "What happened?" }],
    })}\n`,
    "utf8",
  );

  await assert.rejects(
    () =>
      runBenchmark("ama-bench", {
        mode: "full",
        datasetDir,
        system: adapter,
      }),
    /must include a qa_pairs array with question\/answer\/type\/question_uuid strings/,
  );
});
