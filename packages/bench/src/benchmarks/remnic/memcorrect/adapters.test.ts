import test from "node:test";
import assert from "node:assert/strict";
import {
  PromptOnlyBaselineAdapter,
  createRemnicMemCorrectAdapter,
} from "./adapters.js";
import type { BenchMemoryAdapter } from "../../../adapters/types.js";

// ---------------------------------------------------------------------------
// Prompt-only baseline
// ---------------------------------------------------------------------------

test("baseline: recall surfaces turns overlapping the query terms", async () => {
  const adapter = new PromptOnlyBaselineAdapter();
  await adapter.ingestTurn("s1", "user", "My coffee preference is oat-milk.", "2026-07-05T00:00:00Z");
  await adapter.ingestTurn("s1", "user", "The deploy target is canary.", "2026-07-05T00:01:00Z");
  const recalled = await adapter.recall("what is my coffee preference?", "s1");
  assert.ok(recalled.length > 0, "expected at least one recalled turn");
  assert.ok(
    recalled[0].toLowerCase().includes("oat-milk"),
    `top recall should mention oat-milk, got: ${recalled[0]}`,
  );
});

test("baseline: correct() is just another turn (no retire)", async () => {
  const adapter = new PromptOnlyBaselineAdapter();
  await adapter.ingestTurn("s1", "user", "My coffee preference is oat-milk.", "2026-07-05T00:00:00Z");
  await adapter.correct("Correction: coffee is now black-coffee, not oat-milk.", "s1");
  // Both the original and the correction are still in the prompt window.
  const recalled = await adapter.recall("what is my coffee preference?", "s1");
  const joined = recalled.join(" ").toLowerCase();
  assert.ok(joined.includes("oat-milk"), "baseline must NOT retire oat-milk (structural floor)");
  assert.ok(joined.includes("black-coffee"), "baseline should surface the correction turn too");
});

test("baseline: runMaintenance is a no-op", async () => {
  const adapter = new PromptOnlyBaselineAdapter();
  await adapter.runMaintenance(); // must not throw
  const recalled = await adapter.recall("anything", "s1");
  assert.deepEqual(recalled, []);
});

test("baseline: reset clears the store", async () => {
  const adapter = new PromptOnlyBaselineAdapter();
  await adapter.ingestTurn("s1", "user", "fact one", "2026-07-05T00:00:00Z");
  await adapter.reset();
  const recalled = await adapter.recall("fact", "s1");
  assert.deepEqual(recalled, []);
});

// ---------------------------------------------------------------------------
// Remnic-native wrapper (against a fake public BenchMemoryAdapter)
// ---------------------------------------------------------------------------

type CapturedCalls = {
  storeCalls: Array<{ session: string; messages: unknown[] }>;
  recallReturns: string[];
  drainCalls: number;
  resetCalls: number;
};

function newCaptured(): CapturedCalls {
  return { storeCalls: [], recallReturns: [], drainCalls: 0, resetCalls: 0 };
}

function fakeBenchAdapter(captured: CapturedCalls): BenchMemoryAdapter {
  return {
    async store(sessionId, messages) {
      captured.storeCalls.push({ session: sessionId, messages: [...messages] });
    },
    async recall(sessionId, _query) {
      void sessionId;
      return captured.recallReturns.shift() ?? "";
    },
    async search() {
      return [];
    },
    async reset() {
      captured.resetCalls += 1;
    },
    async getStats() {
      return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
    },
    async drain() {
      captured.drainCalls += 1;
    },
    destroy() {
      return Promise.resolve();
    },
  };
}

test("remnic wrapper: ingestTurn routes to store with the session prefix", async () => {
  const captured = newCaptured();
  const adapter = createRemnicMemCorrectAdapter(fakeBenchAdapter(captured), {
    sessionPrefix: "mc",
  });
  await adapter.ingestTurn("ns-a", "user", "hello", "2026-07-05T00:00:00Z");
  assert.equal(captured.storeCalls.length, 1);
  assert.equal(captured.storeCalls[0].session, "mc:ns-a");
});

test("remnic wrapper: recall splits the context blob on blank-line boundaries", async () => {
  const captured = { ...newCaptured(), recallReturns: ["first paragraph\n\nsecond paragraph\n\nthird"] };
  const adapter = createRemnicMemCorrectAdapter(fakeBenchAdapter(captured));
  const recalled = await adapter.recall("q", "ns-a");
  assert.deepEqual(recalled, ["first paragraph", "second paragraph", "third"]);
});

test("remnic wrapper: correct() observes the correction as a user turn", async () => {
  const captured = newCaptured();
  const adapter = createRemnicMemCorrectAdapter(fakeBenchAdapter(captured));
  await adapter.correct("fix this", "ns-a");
  assert.equal(captured.storeCalls.length, 1);
  assert.equal(captured.storeCalls[0].messages.length, 1);
});

test("remnic wrapper: runMaintenance forces a drain", async () => {
  const captured = newCaptured();
  const adapter = createRemnicMemCorrectAdapter(fakeBenchAdapter(captured));
  await adapter.runMaintenance();
  assert.equal(captured.drainCalls, 1);
});

test("remnic wrapper: reset forwards to the underlying adapter reset", async () => {
  const captured = newCaptured();
  const adapter = createRemnicMemCorrectAdapter(fakeBenchAdapter(captured));
  await adapter.reset();
  assert.equal(captured.resetCalls, 1);
});
