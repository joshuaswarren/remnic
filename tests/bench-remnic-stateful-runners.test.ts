import test from "node:test";
import assert from "node:assert/strict";
import type { BenchMemoryAdapter, Message, SearchResult } from "../packages/bench/src/index.js";
import { runBenchmark } from "../packages/bench/src/index.js";

class NoopMemoryAdapter implements BenchMemoryAdapter {
  async store(_sessionId: string, _messages: Message[]): Promise<void> {}

  async recall(_sessionId: string, _query: string): Promise<string> {
    return "";
  }

  async search(
    _query: string,
    _limit: number,
    _sessionId?: string,
  ): Promise<SearchResult[]> {
    return [];
  }

  async reset(_sessionId?: string): Promise<void> {}

  async getStats() {
    return {
      totalMessages: 0,
      totalSummaryNodes: 0,
      maxDepth: 0,
    };
  }

  async destroy(): Promise<void> {}
}

const adapter = new NoopMemoryAdapter();

test("runBenchmark executes entity-consolidation in quick mode", async () => {
  const result = await runBenchmark("entity-consolidation", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "entity-consolidation");
  assert.equal(result.meta.benchmarkTier, "remnic");
  assert.equal(result.results.tasks.length, 3);
  assert.equal(result.results.aggregates.exact_match.mean, 1);
  assert.equal(result.results.aggregates.stale_flag_match.mean, 1);
});

test("runBenchmark executes page-versioning in quick mode", async () => {
  const result = await runBenchmark("page-versioning", {
    mode: "quick",
    system: adapter,
  });

  assert.equal(result.meta.benchmark, "page-versioning");
  assert.equal(result.meta.benchmarkTier, "remnic");
  assert.equal(result.results.tasks.length, 3);
  assert.equal(result.results.aggregates.exact_match.mean, 1);
  assert.equal(result.results.aggregates.history_match.mean, 1);
});
