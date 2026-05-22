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
import {
  renderMemorySummaryForJudge,
  renderMemoryViewForAgent,
  runAssistantBenchmark,
} from "./runner.js";
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

test("assistant judge memory summary includes fact tags hidden from agent view", () => {
  const memoryGraph = {
    userHandle: "test-user",
    userRole: "engineer",
    facts: [
      {
        id: "fact-tagged",
        summary: "The user treats Aurora latency as a review blocker.",
        tags: ["aurora", "latency", "review-blocker"],
      },
    ],
    stances: [],
    openThreads: [],
  };

  const judgeSummary = renderMemorySummaryForJudge(memoryGraph);
  const agentView = renderMemoryViewForAgent(memoryGraph);

  assert.match(
    judgeSummary,
    /fact-tagged: The user treats Aurora latency as a review blocker\. \[tags: aurora, latency, review-blocker\]/,
  );
  assert.doesNotMatch(agentView, /tags:/);
  assert.doesNotMatch(agentView, /review-blocker/);
});

test("assistant memory renderers include fixed current-date anchors", () => {
  const memoryGraph = {
    userHandle: "test-user",
    userRole: "engineer",
    currentDate: "Monday, May 18, 2026",
    facts: [
      {
        id: "fact-deadline",
        summary: "The launch review is due on Thursday, May 21, 2026.",
      },
    ],
    stances: [],
    openThreads: [],
  };

  const judgeSummary = renderMemorySummaryForJudge(memoryGraph);
  const agentView = renderMemoryViewForAgent(memoryGraph);

  assert.match(agentView, /Current date: Monday, May 18, 2026\./);
  assert.match(judgeSummary, /CURRENT_DATE: Monday, May 18, 2026/);
});

test("assistant multi-seed runs reach the agent and feed confidence intervals", async () => {
  const spotCheckDir = mkdtempSync(
    path.join(tmpdir(), "remnic-assistant-seeds-"),
  );
  const seenSeeds: number[] = [];

  try {
    const result = await runAssistantBenchmark(
      definition,
      [scenario],
      resolvedOptions(),
      {
        agent: {
          async respond(request) {
            seenSeeds.push(request.seed);
            return `seed ${request.seed} run ${request.runIndex + 1}/${request.runCount}`;
          },
        },
        judge: seedDependentJudge(),
        seeds: [1, 2, 3],
        spotCheckDir,
        random: cyclingRandom([0, 0.34, 0.67, 0.99]),
      },
    );

    assert.deepEqual(seenSeeds, [1, 2, 3]);
    assert.equal(result.meta.runCount, 3);
    assert.deepEqual(result.meta.seeds, [1, 2, 3]);
    assert.equal(result.results.tasks.length, 1);

    const task = result.results.tasks[0];
    assert.ok(task);
    assert.equal(task.scores.overall, 0.5);

    const perSeedScores = task.details?.perSeedScores;
    assert.ok(Array.isArray(perSeedScores));
    assert.deepEqual(
      perSeedScores.map((entry) => (entry as { seed: number }).seed),
      [1, 2, 3],
    );

    const overallCi = result.results.statistics?.confidenceIntervals.overall;
    assert.ok(overallCi);
    assert.ok(
      overallCi.upper > overallCi.lower,
      "overall CI should be built from the three per-seed scores, not one collapsed task score",
    );
    const identityCi = result.results.statistics?.confidenceIntervals.identity_accuracy;
    assert.ok(identityCi);
    assert.ok(
      identityCi.upper > identityCi.lower,
      "dimension CI should preserve per-seed variance within a single scenario",
    );
  } finally {
    rmSync(spotCheckDir, { recursive: true, force: true });
  }
});

test("assistant confidence intervals bootstrap per-run means across scenarios", async () => {
  const spotCheckDir = mkdtempSync(
    path.join(tmpdir(), "remnic-assistant-per-run-"),
  );
  const secondScenario: AssistantScenario = {
    ...scenario,
    id: "second-scenario",
    title: "Second Scenario",
    scenarioPrompt: "Answer using the user's second project memory.",
  };

  try {
    const result = await runAssistantBenchmark(
      definition,
      [scenario, secondScenario],
      resolvedOptions(),
      {
        agent: immediateAgent,
        judge: scenarioDependentJudge(),
        seeds: [1, 2],
        spotCheckDir,
        random: () => 0,
      },
    );

    const identityCi = result.results.statistics?.confidenceIntervals.identity_accuracy;
    const overallCi = result.results.statistics?.confidenceIntervals.overall;

    assert.ok(identityCi);
    assert.equal(identityCi.lower, 0.5);
    assert.equal(identityCi.upper, 0.5);
    assert.ok(overallCi);
    assert.equal(overallCi.lower, 0.5);
    assert.equal(overallCi.upper, 0.5);
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

function seedDependentJudge(): StructuredJudge {
  return {
    async evaluate(request) {
      const seed = Number(request.taskId.match(/#seed-(\d+)$/)?.[1] ?? 0);
      const score = seed === 1 ? 0 : seed === 2 ? 0.5 : 1;
      return JSON.stringify({
        identity_accuracy: score,
        stance_coherence: score,
        novelty: score,
        calibration: score,
        notes: `seed ${seed}`,
      });
    },
  };
}

function scenarioDependentJudge(): StructuredJudge {
  return {
    async evaluate(request) {
      const seed = Number(request.taskId.match(/#seed-(\d+)$/)?.[1] ?? 0);
      const score = request.taskId.includes("second-scenario") || seed === 2 ? 1 : 0;
      return JSON.stringify({
        identity_accuracy: score,
        stance_coherence: score,
        novelty: score,
        calibration: score,
        notes: `scenario score ${score}`,
      });
    },
  };
}

function cyclingRandom(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index % values.length]!;
    index += 1;
    return value;
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
