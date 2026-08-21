import assert from "node:assert/strict";
import test from "node:test";

import type {
  BenchMemoryAdapter,
  MemoryStats,
  Message,
  SearchResult,
} from "../../../adapters/types.js";
import type { ResolvedRunBenchmarkOptions } from "../../../types.js";
import {
  RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE,
  type RetrievalPersonalizationCase,
} from "./fixture.js";
import {
  retrievalPersonalizationDefinition,
  runRetrievalPersonalizationBenchmark,
} from "./runner.js";

interface RecallCall {
  sessionId: string;
  query: string;
  budgetChars?: number;
}

class SpyPersonalizationAdapter implements BenchMemoryAdapter {
  readonly resetSessions: string[] = [];
  readonly storeCalls: Array<{ sessionId: string; messages: Message[] }> = [];
  readonly recallCalls: RecallCall[] = [];
  drainCalls = 0;

  constructor(
    private readonly recallTextForCase: (sample: RetrievalPersonalizationCase) => string,
  ) {}

  async reset(sessionId?: string): Promise<void> {
    assert.ok(sessionId, "retrieval-personalization should reset the case session");
    this.resetSessions.push(sessionId);
  }

  async store(sessionId: string, messages: Message[]): Promise<void> {
    this.storeCalls.push({ sessionId, messages });
  }

  async recall(sessionId: string, query: string, budgetChars?: number): Promise<string> {
    const sample = sampleForSession(sessionId);
    assert.equal(query, sample.query);
    assert.equal(budgetChars, 12_000);
    this.recallCalls.push({ sessionId, query, budgetChars });
    return this.recallTextForCase(sample);
  }

  async search(): Promise<SearchResult[]> {
    throw new Error("retrieval-personalization should use recall, not fixture search");
  }

  async getStats(): Promise<MemoryStats> {
    return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
  }

  async drain(): Promise<void> {
    this.drainCalls += 1;
  }

  async destroy(): Promise<void> {}
}

function buildOptions(
  system: BenchMemoryAdapter,
  overrides: Partial<ResolvedRunBenchmarkOptions> = {},
): ResolvedRunBenchmarkOptions {
  return {
    benchmark: {
      ...retrievalPersonalizationDefinition,
      run: runRetrievalPersonalizationBenchmark,
    },
    mode: "quick",
    system,
    ...overrides,
  } as ResolvedRunBenchmarkOptions;
}

function sampleForSession(sessionId: string): RetrievalPersonalizationCase {
  const sampleId = sessionId.replace(/^retrieval-personalization:/, "");
  const sample = RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.find(
    (entry) => entry.id === sampleId,
  );
  assert.ok(sample, `unexpected session ${sessionId}`);
  return sample;
}

test("retrieval-personalization seeds and queries the supplied system adapter", async () => {
  const adapter = new SpyPersonalizationAdapter(
    (sample) => `recall hit\npage_id: ${sample.expectedPageIds[0]}`,
  );

  const result = await runRetrievalPersonalizationBenchmark(buildOptions(adapter));

  assert.equal(result.results.tasks.length, RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.length);
  assert.deepEqual(
    adapter.resetSessions,
    RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.map((sample) => `retrieval-personalization:${sample.id}`),
  );
  assert.equal(adapter.storeCalls.length, RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.length);
  assert.equal(adapter.recallCalls.length, RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.length);
  assert.equal(adapter.drainCalls, RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.length);

  for (const [index, call] of adapter.storeCalls.entries()) {
    const sample = RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE[index]!;
    assert.equal(call.messages.length, sample.pages.length);
    assert.match(call.messages[0]!.content, /^page_id: /);
    assert.match(call.messages[0]!.content, /owner: /);
    assert.match(call.messages[0]!.content, /namespace: /);
  }

  for (const task of result.results.tasks) {
    assert.equal(task.scores.p_at_1, 1);
    assert.ok(task.scores.p_at_3 > 0);
    assert.ok(task.scores.p_at_5 > 0);
  }
});

test("retrieval-personalization scores adapter-returned page ids instead of fixture ranking", async () => {
  const adapter = new SpyPersonalizationAdapter((sample) => {
    const wrongPage = sample.pages.find(
      (page) => !sample.expectedPageIds.includes(page.id),
    );
    assert.ok(wrongPage);
    return `recall hit\npage_id: ${wrongPage.id}`;
  });

  const result = await runRetrievalPersonalizationBenchmark(buildOptions(adapter));

  for (const task of result.results.tasks) {
    assert.equal(task.scores.p_at_1, 0);
    assert.equal(task.scores.p_at_3, 0);
    assert.equal(task.scores.p_at_5, 0);
  }
});

test("retrieval-personalization reports progress after each completed task", async () => {
  const adapter = new SpyPersonalizationAdapter(
    (sample) => `recall hit\npage_id: ${sample.expectedPageIds[0]}`,
  );
  const completed: Array<{ taskId: string; completedCount: number; totalCount?: number }> = [];

  const result = await runRetrievalPersonalizationBenchmark(
    buildOptions(adapter, {
      onTaskComplete(task, completedCount, totalCount) {
        completed.push({ taskId: task.taskId, completedCount, totalCount });
      },
    }),
  );

  assert.deepEqual(
    completed.map((entry) => entry.taskId),
    result.results.tasks.map((task) => task.taskId),
  );
  assert.deepEqual(
    completed.map((entry) => entry.completedCount),
    result.results.tasks.map((_, index) => index + 1),
  );
  assert.deepEqual(
    completed.map((entry) => entry.totalCount),
    result.results.tasks.map(() => RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.length),
  );
});

test("retrieval-personalization limit preserves clean and dirty pairs", async () => {
  const adapter = new SpyPersonalizationAdapter(
    (sample) => `recall hit\npage_id: ${sample.expectedPageIds[0]}`,
  );

  const result = await runRetrievalPersonalizationBenchmark(
    buildOptions(adapter, { limit: 1 }),
  );

  const expectedPair = RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.slice(0, 2);
  assert.deepEqual(
    result.results.tasks.map((task) => task.taskId),
    expectedPair.map((sample) => sample.id),
  );
  assert.deepEqual(
    result.results.tasks.map((task) => task.details?.tier),
    ["clean", "dirty"],
  );
  assert.deepEqual(
    adapter.recallCalls.map((call) => call.sessionId),
    expectedPair.map((sample) => `retrieval-personalization:${sample.id}`),
  );
});

test("retrieval-personalization does not score prefixed page id matches", async () => {
  const adapter = new SpyPersonalizationAdapter(
    (sample) => `recall hit\npage_id: ${sample.expectedPageIds[0]}-shadow`,
  );

  const result = await runRetrievalPersonalizationBenchmark(buildOptions(adapter));

  for (const task of result.results.tasks) {
    assert.equal(task.scores.p_at_1, 0);
    assert.equal(task.scores.p_at_3, 0);
    assert.equal(task.scores.p_at_5, 0);
    assert.match(task.actual, /-shadow/);
  }
});

test("retrieval-personalization keeps unknown recall hits as ranking negatives", async () => {
  const adapter = new SpyPersonalizationAdapter(
    (sample) => [
      "recall hit",
      "page_id: outside-fixture",
      `page_id: ${sample.expectedPageIds[0]}`,
    ].join("\n"),
  );

  const result = await runRetrievalPersonalizationBenchmark(buildOptions(adapter));

  for (const task of result.results.tasks) {
    assert.equal(task.scores.p_at_1, 0);
    assert.equal(task.scores.p_at_3, 1 / 3);
    assert.equal(task.scores.p_at_5, 1 / 5);
    assert.match(task.actual, /outside-fixture/);
  }
});

test("retrieval-personalization fails when the system adapter cannot be reset", async () => {
  const adapter = new SpyPersonalizationAdapter(() => "");
  adapter.reset = async () => {
    throw new Error("forced reset failure");
  };

  await assert.rejects(
    () => runRetrievalPersonalizationBenchmark(buildOptions(adapter)),
    /forced reset failure/,
  );
  assert.equal(adapter.storeCalls.length, 0);
  assert.equal(adapter.recallCalls.length, 0);
});
