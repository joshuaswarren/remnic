import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BenchMemoryAdapter } from "../../../adapters/types.ts";
import { locomoDefinition, runLoCoMoBenchmark } from "./runner.ts";

type CompositionScenario = {
  question: string;
  expected: string;
  recalledBySession: readonly string[];
  requiredContext: readonly string[];
  option?: unknown;
  category?: number;
  onReset?: () => void;
};

async function runCompositionScenario(scenario: CompositionScenario) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "remnic-locomo-compose-"));
  const responderContexts: string[] = [];
  let resetCalls = 0;
  try {
    const sessions = Object.fromEntries(
      scenario.recalledBySession.map((_recalled, index) => [
        `session_${index + 1}`,
        [{
          speaker: "Maya",
          dia_id: `D${index + 1}:1`,
          text: `Synthetic conversation turn ${index + 1}.`,
        }],
      ]),
    );
    await writeFile(
      path.join(tempDir, "locomo10.json"),
      JSON.stringify([{
        sample_id: "locomo-composition-synthetic",
        conversation: {
          speaker_a: "Maya",
          speaker_b: "Assistant",
          ...sessions,
        },
        qa: [{
          question: scenario.question,
          answer: scenario.expected,
          evidence: ["D1:1"],
          category: scenario.category ?? 1,
        }],
      }]),
      "utf8",
    );

    const system: BenchMemoryAdapter = {
      async store() {},
      async recall(sessionId) {
        const match = sessionId.match(/session_(\d+)$/);
        const index = Number(match?.[1] ?? 0) - 1;
        return scenario.recalledBySession[index] ?? "";
      },
      async search() {
        return [];
      },
      async reset() {
        resetCalls += 1;
        scenario.onReset?.();
      },
      async destroy() {},
      async getStats() {
        return { totalMessages: 0, totalSummaryNodes: 0, maxDepth: 0 };
      },
      responder: {
        async respond(_question, recalledText) {
          responderContexts.push(recalledText);
          const hasWholeChain = scenario.requiredContext.every((part) =>
            recalledText.includes(part)
          );
          return {
            text: hasWholeChain ? scenario.expected : "unknown",
            tokens: { input: 1, output: 1 },
            latencyMs: 0,
            model: "locomo-composition-test-responder",
          };
        },
      },
      judge: {
        async score() {
          return 1;
        },
        async scoreWithMetrics() {
          return {
            score: 1,
            tokens: { input: 0, output: 0 },
            latencyMs: 0,
            model: "locomo-composition-test-judge",
          };
        },
      },
    };

    const result = await runLoCoMoBenchmark({
      benchmark: locomoDefinition,
      mode: "full",
      datasetDir: tempDir,
      system,
      ...(scenario.option === undefined
        ? {}
        : { benchmarkOptions: { multiHopRecallComposition: scenario.option } }),
    });
    return { result, responderContexts, resetCalls };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("LoCoMo composes a recalled bridge fact without category or answer leakage", async () => {
  const direct = "Maya: My sister is Lena.";
  const linked = "Lena: I joined Northstar Observatory.";
  const unrelated = "Priya: I joined Riverside Studio.";
  const { result, responderContexts } = await runCompositionScenario({
    question: "Which organization is associated with Maya's sister?",
    expected: "Northstar Observatory",
    recalledBySession: [direct, linked, unrelated],
    requiredContext: [direct, linked],
    // Deliberately not the LoCoMo multi-hop category: composition must be
    // query/evidence driven rather than category-label driven.
    category: 1,
  });

  const context = responderContexts[0]!;
  assert.equal(result.results.tasks[0]?.actual, "Northstar Observatory");
  assert.match(context, /LoCoMo Linked Evidence \(hop 1\)/);
  assert.ok(context.indexOf(direct) < context.indexOf(linked));
  assert.doesNotMatch(context, /Riverside Studio/);
  assert.equal(
    result.config.benchmarkOptions?.multiHopRecallComposition,
    true,
  );
});

test("LoCoMo composition follows a stable two-hop chain in recalled text", async () => {
  const direct = "Maya: My mentor is Arun.";
  const firstBridge = "Arun: I lead the Lantern Circle.";
  const secondBridge = "The Lantern Circle gathers at Cedar Hall.";
  const scenario = {
    question: "Which venue is associated with Maya's mentor?",
    expected: "Cedar Hall",
    recalledBySession: [direct, firstBridge, secondBridge],
    requiredContext: [direct, firstBridge, secondBridge],
  };
  const { result, responderContexts } = await runCompositionScenario(scenario);
  const repeated = await runCompositionScenario(scenario);

  const context = responderContexts[0]!;
  assert.equal(result.results.tasks[0]?.actual, "Cedar Hall");
  assert.match(context, /LoCoMo Linked Evidence \(hop 1\)/);
  assert.match(context, /LoCoMo Linked Evidence \(hop 2\)/);
  assert.ok(context.indexOf(direct) < context.indexOf(firstBridge));
  assert.ok(context.indexOf(firstBridge) < context.indexOf(secondBridge));
  assert.equal(repeated.responderContexts[0], context);
});

test("false-like multi-hop options preserve the direct-only recall transform", async () => {
  for (const option of [false, "false", "0", "no", "off"]) {
    const direct = "Maya: My sister is Lena.";
    const linked = "Lena: I joined Northstar Observatory.";
    const { result, responderContexts } = await runCompositionScenario({
      question: "Which organization is associated with Maya's sister?",
      expected: "Northstar Observatory",
      recalledBySession: [direct, linked],
      requiredContext: [direct, linked],
      option,
    });

    assert.equal(result.results.tasks[0]?.actual, "unknown", `option=${option}`);
    assert.match(responderContexts[0]!, /Maya: My sister is Lena/);
    assert.doesNotMatch(responderContexts[0]!, /Northstar Observatory/);
    assert.equal(
      result.config.benchmarkOptions?.multiHopRecallComposition,
      false,
    );
  }
});

test("LoCoMo rejects invalid multi-hop configuration before side effects", async () => {
  let resetCalls = 0;
  await assert.rejects(
    () => runCompositionScenario({
      question: "Which organization is associated with Maya's sister?",
      expected: "Northstar Observatory",
      recalledBySession: ["Maya: My sister is Lena."],
      requiredContext: [],
      option: "sometimes",
      onReset: () => {
        resetCalls += 1;
      },
    }),
    /multiHopRecallComposition must be a boolean/,
  );
  assert.equal(resetCalls, 0);
});
