import assert from "node:assert/strict";
import test from "node:test";

import type {
  BenchMemoryAdapter,
  BenchRecallSupportAssessment,
  BenchRecallSupportRequest,
  Message,
} from "../../adapters/types.ts";
import type {
  BenchmarkDefinition,
  ResolvedRunBenchmarkOptions,
} from "../../types.ts";
import {
  runPublishedHarness,
  type HarnessTrial,
} from "./harness.ts";

const definition: BenchmarkDefinition = {
  id: "answer-support-gate-test",
  title: "Answer Support Gate Test",
  tier: "published",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "answer-support-gate-test",
    version: "1",
    description: "test",
    category: "retrieval",
    citation: "test",
  },
};

function makeSystem(options: {
  recalledText: string;
  answer?: string;
  assess?: (
    request: BenchRecallSupportRequest,
  ) => Promise<BenchRecallSupportAssessment>;
}) {
  const prompts: string[] = [];
  const contexts: string[] = [];
  const system: BenchMemoryAdapter = {
    async store(_sessionId: string, _messages: Message[]) {},
    async recall() {
      return options.recalledText;
    },
    ...(options.assess ? { assessRecallSupport: options.assess } : {}),
    async search() {
      return [];
    },
    async reset() {},
    async getStats() {
      return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
    },
    async destroy() {},
    responder: {
      async respond(question, recalledText) {
        prompts.push(question);
        contexts.push(recalledText);
        return {
          text: question.includes("Recall support gate:")
            ? "unknown"
            : (options.answer ?? "Seattle"),
          tokens: { input: 1, output: 1 },
          latencyMs: 0,
          model: "support-test-responder",
        };
      },
    },
  };
  return { system, prompts, contexts };
}

async function runTrial(options: {
  system: BenchMemoryAdapter;
  gate: unknown;
  trial?: Partial<HarnessTrial>;
}) {
  const resolvedOptions: ResolvedRunBenchmarkOptions = {
    benchmark: definition,
    mode: "quick",
    system: options.system,
    seed: 1,
    remnicConfig: { answerSupportGate: options.gate },
  };
  return runPublishedHarness({
    options: resolvedOptions,
    metricsSpec: { metrics: ["f1"] },
    plans: [{
      ingestSessions: [],
      trials: [{
        taskId: "support-trial",
        question: "Which city did Maya move to?",
        expected: "Seattle",
        recallSessionIds: ["session-1"],
        ...options.trial,
      }],
    }],
  });
}

test("answer support gate instructs abstention after a successful empty recall", async () => {
  const { system, prompts } = makeSystem({ recalledText: "" });
  const result = await runTrial({ system, gate: true });
  const task = result.results.tasks[0]!;
  assert.ok(task);

  assert.equal(task.actual, "unknown");
  assert.match(prompts[0]!, /successful recall returned no evidence/);
  assert.deepEqual(task.details!.recallSupport, {
    status: "empty",
    reason: "successful recall returned empty responder context",
    evidenceCount: 0,
  });
});

test("answer support gate accepts explicit bounded weak support from the exact answer context", async () => {
  const { system, prompts, contexts } = makeSystem({
    recalledText: "raw recall",
    assess: async (request) => {
      assert.equal(request.query, "Which city did Maya move to?");
      assert.equal(request.recalledText, "matched but low-confidence evidence");
      assert.deepEqual(request.sessionIds, ["session-1"]);
      return {
        status: "weak",
        evidenceCount: 1,
        maxScore: 0.2,
        supportThreshold: 0.5,
      };
    },
  });
  const result = await runTrial({
    system,
    gate: "yes",
    trial: {
      recallTextTransform: () => "matched but low-confidence evidence",
    },
  });

  assert.equal(result.results.tasks[0]?.actual, "unknown");
  assert.equal(contexts[0], "matched but low-confidence evidence");
  assert.match(prompts[0]!, /explicitly classified.*weak/);
});

test("supported answerable categories preserve factual answering", async () => {
  const { system, prompts } = makeSystem({
    recalledText: "Maya moved to Seattle.",
    assess: async () => ({ status: "supported", evidenceCount: 1 }),
  });
  const result = await runTrial({
    system,
    gate: "on",
    trial: { extraDetails: { locomoCategory: 1 } },
  });
  const task = result.results.tasks[0]!;
  assert.ok(task);

  assert.equal(task.actual, "Seattle");
  assert.equal(task.details!.locomoCategory, 1);
  assert.deepEqual(task.details!.recallSupport, {
    status: "supported",
    evidenceCount: 1,
  });
  assert.doesNotMatch(prompts[0]!, /Recall support gate:/);
});

test("support-assessment backend failure remains distinct and does not force abstention", async () => {
  const { system, prompts } = makeSystem({
    recalledText: "Maya moved to Seattle.",
    assess: async () => {
      throw new Error("support backend timed out");
    },
  });
  const result = await runTrial({ system, gate: true });
  const task = result.results.tasks[0]!;
  assert.ok(task);

  assert.equal(task.actual, "Seattle");
  assert.deepEqual(task.details!.recallSupport, {
    status: "backend_failure",
    reason: "support backend timed out",
  });
  assert.doesNotMatch(prompts[0]!, /Recall support gate:/);
});

test("string false-like config disables the gate without vacuous coercion", async () => {
  for (const gate of ["false", "0", "no", "off"]) {
    const { system, prompts } = makeSystem({ recalledText: "" });
    const result = await runTrial({ system, gate });
    const task = result.results.tasks[0]!;
    assert.ok(task);
    assert.equal(task.actual, "Seattle", `gate=${gate}`);
    assert.doesNotMatch(prompts[0]!, /Recall support gate:/, `gate=${gate}`);
    assert.equal(task.details!.answerSupportGate, undefined);
  }
});

test("invalid answer support config is rejected before any trial runs", async () => {
  const { system, prompts } = makeSystem({ recalledText: "" });
  await assert.rejects(
    () => runTrial({ system, gate: "sometimes" }),
    /answerSupportGate must be a boolean/,
  );
  assert.deepEqual(prompts, []);
});
