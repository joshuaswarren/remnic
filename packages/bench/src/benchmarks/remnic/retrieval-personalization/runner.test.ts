import assert from "node:assert/strict";
import test from "node:test";

import type {
  BenchMemoryAdapter,
  BenchRecallOptions,
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
  options?: BenchRecallOptions;
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

  async recall(
    sessionId: string,
    query: string,
    budgetChars?: number,
    options?: BenchRecallOptions,
  ): Promise<string> {
    const sample = sampleForSession(sessionId);
    assert.equal(query, sample.query);
    assert.equal(budgetChars, 12_000);
    assert.equal(options, undefined);
    this.recallCalls.push({ sessionId, query, budgetChars, options });
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

function buildOptions(system: BenchMemoryAdapter): ResolvedRunBenchmarkOptions {
  return {
    benchmark: {
      ...retrievalPersonalizationDefinition,
      run: runRetrievalPersonalizationBenchmark,
    },
    mode: "quick",
    system,
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

  assert.equal(
    result.results.tasks.length,
    RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.length,
  );
  assert.deepEqual(
    adapter.resetSessions,
    RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.map(
      (sample) => `retrieval-personalization:${sample.id}`,
    ),
  );
  assert.equal(adapter.storeCalls.length, RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.length);
  assert.equal(adapter.recallCalls.length, RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.length);
  assert.equal(adapter.drainCalls, RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE.length);

  for (const [index, call] of adapter.storeCalls.entries()) {
    const sample = RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE[index]!;
    assert.equal(call.messages.length, sample.pages.length);
    assert.match(call.messages[0]!.content, /^page_id: /);
    assert.match(call.messages[0]!.content, /^owner: /m);
    assert.match(call.messages[0]!.content, /^namespace: /m);
    assert.equal(call.messages[0]!.timestamp, sample.pages[0]!.createdAt);
  }

  for (const task of result.results.tasks) {
    assert.equal(task.scores.p_at_1, 1);
    assert.equal(task.scores.p_at_3, 1 / 3);
    assert.equal(task.scores.p_at_5, 1 / 5);
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

test("retrieval-personalization does not match page ids by prefix", async () => {
  const adapter = new SpyPersonalizationAdapter((sample) => {
    const expectedPageId = sample.expectedPageIds[0]!;
    return `recall hit\npage_id: ${expectedPageId}-suffix`;
  });

  const result = await runRetrievalPersonalizationBenchmark(buildOptions(adapter));

  for (const task of result.results.tasks) {
    assert.equal(task.scores.p_at_1, 0);
    assert.equal(task.scores.p_at_3, 0);
    assert.equal(task.scores.p_at_5, 0);
    assert.deepEqual(task.details?.retrievedPageIds, []);
  }
});

test("retrieval-personalization extracts page ids from labeled evidence lines", async () => {
  const adapter = new SpyPersonalizationAdapter(
    (sample) => `[retrieval-personalization, turn 1, user]: page_id: ${sample.expectedPageIds[0]}`,
  );

  const result = await runRetrievalPersonalizationBenchmark(buildOptions(adapter));

  for (const [index, task] of result.results.tasks.entries()) {
    const sample = RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE[index]!;
    assert.equal(task.scores.p_at_1, 1);
    assert.deepEqual(task.details?.retrievedPageIds, [sample.expectedPageIds[0]]);
  }
});

test("retrieval-personalization strips surrounding punctuation from page ids", async () => {
  const adapter = new SpyPersonalizationAdapter(
    (sample) => `recall hit: page_id: \`${sample.expectedPageIds[0]}.\``,
  );

  const result = await runRetrievalPersonalizationBenchmark(buildOptions(adapter));

  for (const [index, task] of result.results.tasks.entries()) {
    const sample = RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE[index]!;
    assert.equal(task.scores.p_at_1, 1);
    assert.deepEqual(task.details?.retrievedPageIds, [sample.expectedPageIds[0]]);
  }
});

test("retrieval-personalization strips bracket wrappers from page ids", async () => {
  const adapter = new SpyPersonalizationAdapter(
    (sample) => `recall hit: page_id: [${sample.expectedPageIds[0]}]`,
  );

  const result = await runRetrievalPersonalizationBenchmark(buildOptions(adapter));

  for (const [index, task] of result.results.tasks.entries()) {
    const sample = RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE[index]!;
    assert.equal(task.scores.p_at_1, 1);
    assert.deepEqual(task.details?.retrievedPageIds, [sample.expectedPageIds[0]]);
  }
});

test("retrieval-personalization scores uppercased page ids case-insensitively", async () => {
  const adapter = new SpyPersonalizationAdapter(
    (sample) => `recall hit: page_id: ${sample.expectedPageIds[0]!.toUpperCase()}`,
  );

  const result = await runRetrievalPersonalizationBenchmark(buildOptions(adapter));

  for (const [index, task] of result.results.tasks.entries()) {
    const sample = RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE[index]!;
    assert.equal(task.scores.p_at_1, 1);
    assert.deepEqual(task.details?.retrievedPageIds, [sample.expectedPageIds[0]]);
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
