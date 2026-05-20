import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import type { BenchMemoryAdapter } from "../../../adapters/types.js";
import type {
  BenchmarkDefinition,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import type { StructuredJudge } from "../../../judges/sealed-rubric.js";
import { runAssistantBenchmark } from "./runner.js";
import type { AssistantAgent, AssistantScenario } from "./types.js";

test("assistant benchmark latency includes judge wall time", async () => {
  const spotCheckDir = mkdtempSync(
    path.join(tmpdir(), "remnic-assistant-latency-"),
  );

  try {
    const judgeDelayMs = 40;
    const result = await runAssistantBenchmark(
      definition,
      [scenario],
      resolvedOptions(),
      {
        agent: immediateAgent,
        judge: delayedJudge(judgeDelayMs),
        seeds: [101],
        spotCheckDir,
        random: () => 0.5,
      },
    );

    const [task] = result.results.tasks;
    assert.ok(task);
    assert.equal(task.taskId, "latency-scenario");
    assert.ok(
      task.latencyMs >= judgeDelayMs - 5,
      `task latency ${task.latencyMs} should include judge delay`,
    );
    assert.ok(
      result.cost.totalLatencyMs >= judgeDelayMs - 5,
      `total latency ${result.cost.totalLatencyMs} should include judge delay`,
    );
    assert.equal(result.cost.totalLatencyMs, task.latencyMs);

    const perSeedScores = task.details?.perSeedScores;
    assert.ok(Array.isArray(perSeedScores));
    const perSeed = perSeedScores[0] as
      | {
          agentLatencyMs?: number;
          judgeLatencyMs?: number;
          latencyMs?: number;
        }
      | undefined;
    assert.ok(perSeed);
    assert.ok(
      typeof perSeed.judgeLatencyMs === "number" &&
        perSeed.judgeLatencyMs >= judgeDelayMs - 5,
      `judge latency ${perSeed.judgeLatencyMs} should include judge delay`,
    );
    assert.equal(
      perSeed.latencyMs,
      (perSeed.agentLatencyMs ?? 0) + perSeed.judgeLatencyMs,
    );
  } finally {
    rmSync(spotCheckDir, { recursive: true, force: true });
  }
});

const definition: BenchmarkDefinition = {
  id: "assistant-latency-test",
  title: "Assistant Latency Test",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "assistant-latency-test",
    version: "1.0.0",
    description: "Verifies assistant benchmark latency accounting.",
    category: "agentic",
  },
};

const scenario: AssistantScenario = {
  id: "latency-scenario",
  title: "Latency Scenario",
  scenarioPrompt: "Answer using the user's project memory.",
  focus: "latency",
  memoryGraph: {
    userHandle: "test-user",
    userRole: "engineer",
    facts: [
      {
        id: "fact-1",
        summary: "The user prefers benchmark latency to include judge work.",
      },
    ],
    stances: [],
    openThreads: [],
  },
};

const immediateAgent: AssistantAgent = {
  async respond() {
    return "The benchmark should count both assistant and judge latency.";
  },
};

function delayedJudge(delayMs: number): StructuredJudge {
  return {
    async evaluate() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return JSON.stringify({
        identity_accuracy: 1,
        stance_coherence: 1,
        novelty: 1,
        calibration: 1,
        notes: "ok",
      });
    },
  };
}

function resolvedOptions(): ResolvedRunBenchmarkOptions {
  return {
    benchmark: definition,
    mode: "quick",
    system: noopAdapter,
  };
}

const noopAdapter: BenchMemoryAdapter = {
  async store() {},
  async recall() {
    return "";
  },
  async search() {
    return [];
  },
  async reset() {},
  async getStats() {
    return {
      totalMessages: 0,
      totalSummaryNodes: 0,
      maxDepth: 0,
    };
  },
  async destroy() {},
};
