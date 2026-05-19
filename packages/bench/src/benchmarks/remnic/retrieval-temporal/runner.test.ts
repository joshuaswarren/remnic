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
  RETRIEVAL_TEMPORAL_SMOKE_FIXTURE,
  type RetrievalTemporalCase,
} from "./fixture.js";
import {
  retrievalTemporalDefinition,
  runRetrievalTemporalBenchmark,
} from "./runner.js";

interface RecallCall {
  sessionId: string;
  query: string;
  budgetChars?: number;
  options?: BenchRecallOptions;
}

class SpyTemporalAdapter implements BenchMemoryAdapter {
  readonly resetSessions: string[] = [];
  readonly storeCalls: Array<{ sessionId: string; messages: Message[] }> = [];
  readonly recallCalls: RecallCall[] = [];
  drainCalls = 0;

  constructor(
    private readonly recallTextForCase: (sample: RetrievalTemporalCase) => string,
  ) {}

  async reset(sessionId?: string): Promise<void> {
    assert.ok(sessionId, "retrieval-temporal should reset the case session");
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
    assert.equal(options?.asOf, sample.window.end);
    this.recallCalls.push({ sessionId, query, budgetChars, options });
    return this.recallTextForCase(sample);
  }

  async search(): Promise<SearchResult[]> {
    throw new Error("retrieval-temporal should use recall with asOf, not untimed search");
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
      ...retrievalTemporalDefinition,
      run: runRetrievalTemporalBenchmark,
    },
    mode: "quick",
    system,
  } as ResolvedRunBenchmarkOptions;
}

function sampleForSession(sessionId: string): RetrievalTemporalCase {
  const sampleId = sessionId.replace(/^retrieval-temporal:/, "");
  const sample = RETRIEVAL_TEMPORAL_SMOKE_FIXTURE.find(
    (entry) => entry.id === sampleId,
  );
  assert.ok(sample, `unexpected session ${sessionId}`);
  return sample;
}

test("retrieval-temporal seeds and queries the supplied system adapter", async () => {
  const adapter = new SpyTemporalAdapter(
    (sample) => `recall hit\npage_id: ${sample.expectedPageIds[0]}`,
  );

  const result = await runRetrievalTemporalBenchmark(buildOptions(adapter));

  assert.equal(result.results.tasks.length, RETRIEVAL_TEMPORAL_SMOKE_FIXTURE.length);
  assert.deepEqual(
    adapter.resetSessions,
    RETRIEVAL_TEMPORAL_SMOKE_FIXTURE.map((sample) => `retrieval-temporal:${sample.id}`),
  );
  assert.equal(adapter.storeCalls.length, RETRIEVAL_TEMPORAL_SMOKE_FIXTURE.length);
  assert.equal(adapter.recallCalls.length, RETRIEVAL_TEMPORAL_SMOKE_FIXTURE.length);
  assert.equal(adapter.drainCalls, RETRIEVAL_TEMPORAL_SMOKE_FIXTURE.length);

  for (const [index, call] of adapter.storeCalls.entries()) {
    const sample = RETRIEVAL_TEMPORAL_SMOKE_FIXTURE[index]!;
    assert.equal(call.messages.length, sample.pages.length);
    assert.match(call.messages[0]!.content, /^page_id: /);
    assert.equal(call.messages[0]!.timestamp, sample.pages[0]!.createdAt);
  }

  for (const task of result.results.tasks) {
    assert.equal(task.scores.qrel_at_1, 1);
    assert.equal(task.scores.qrel_at_3, 1);
    assert.equal(task.scores.qrel_at_5, 1);
  }
});

test("retrieval-temporal scores adapter-returned page ids instead of fixture ranking", async () => {
  const adapter = new SpyTemporalAdapter((sample) => {
    const wrongPage = sample.pages.find(
      (page) => !sample.expectedPageIds.includes(page.id),
    );
    assert.ok(wrongPage);
    return `recall hit\npage_id: ${wrongPage.id}`;
  });

  const result = await runRetrievalTemporalBenchmark(buildOptions(adapter));

  for (const task of result.results.tasks) {
    assert.equal(task.scores.qrel_at_1, 0);
    assert.equal(task.scores.qrel_at_3, 0);
    assert.equal(task.scores.qrel_at_5, 0);
  }
});

test("retrieval-temporal does not score prefixed page id matches", async () => {
  const adapter = new SpyTemporalAdapter(
    (sample) => `recall hit\npage_id: ${sample.expectedPageIds[0]}-shadow`,
  );

  const result = await runRetrievalTemporalBenchmark(buildOptions(adapter));

  for (const task of result.results.tasks) {
    assert.equal(task.scores.qrel_at_1, 0);
    assert.equal(task.scores.qrel_at_3, 0);
    assert.equal(task.scores.qrel_at_5, 0);
  }
});

test("retrieval-temporal fails when the system adapter cannot be reset", async () => {
  const adapter = new SpyTemporalAdapter(() => "");
  adapter.reset = async () => {
    throw new Error("forced reset failure");
  };

  await assert.rejects(
    () => runRetrievalTemporalBenchmark(buildOptions(adapter)),
    /forced reset failure/,
  );
  assert.equal(adapter.storeCalls.length, 0);
  assert.equal(adapter.recallCalls.length, 0);
});
