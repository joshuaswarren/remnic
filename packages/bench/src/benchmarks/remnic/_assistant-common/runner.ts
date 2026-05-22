/**
 * Shared runner scaffolding for the Assistant bench tier.
 *
 * Builds the `BenchmarkResult` shape used by the existing dashboard, but with
 * per-dimension rubric scores (identity_accuracy, stance_coherence, novelty,
 * calibration) and bootstrap 95% confidence intervals attached. Each
 * scenario is executed `runCount` times (default 5) and the per-run means
 * feed the bootstrap so the dashboard can render error bars.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  aggregateTaskScores,
  timed,
} from "../../../scorer.js";
import { buildBenchmarkRunSeeds } from "../../../run-seeds.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { bootstrapMeanConfidenceInterval } from "../../../stats/bootstrap.js";
import type {
  AggregateMetrics,
  BenchmarkDefinition,
  BenchmarkResult,
  ConfidenceInterval,
  ResolvedRunBenchmarkOptions,
  StatisticalReport,
  TaskResult,
} from "../../../types.js";
import {
  ASSISTANT_RUBRIC_DIMENSIONS,
  loadSealedRubric,
  runSealedJudge,
  createSpotCheckFileLogger,
  type AssistantRubricDimension,
  type AssistantRubricScores,
  type SealedJudgeDecision,
  type SealedRubric,
} from "../../../judges/sealed-rubric.js";
import type {
  AssistantMemoryGraph,
  AssistantRunnerOptions,
  AssistantScenario,
} from "./types.js";

const DEFAULT_RUN_COUNT = 5;
const DEFAULT_BOOTSTRAP_ITERATIONS = 1_000;

interface PerScenarioRunResult {
  seed: number;
  decision: SealedJudgeDecision;
  agentLatencyMs: number;
  judgeLatencyMs: number;
  latencyMs: number;
  assistantOutput: string;
}

export async function runAssistantBenchmark(
  definition: BenchmarkDefinition,
  scenarios: AssistantScenario[],
  resolved: ResolvedRunBenchmarkOptions,
  runnerOptions: AssistantRunnerOptions,
): Promise<BenchmarkResult> {
  if (scenarios.length === 0) {
    throw new Error(
      `Assistant benchmark "${definition.id}" received an empty scenario list`,
    );
  }

  const seeds = resolveSeeds(runnerOptions, resolved);
  const runCount = seeds.length;

  const rubric = loadSealedRubric(runnerOptions.rubricId);
  const runId = buildRunId(definition.id);
  const spotCheckLogger = createSpotCheckFileLogger({
    runId,
    directory:
      runnerOptions.spotCheckDir ??
      path.join(process.cwd(), "benchmarks", "results", "spot-checks"),
    sampleRate: 0.35,
    sampleSize: 5,
  });

  const tasks: TaskResult[] = [];
  const perScenarioRuns: PerScenarioRunResult[][] = [];

  for (const scenario of scenarios) {
    const perSeedResults: PerScenarioRunResult[] = [];

    for (const [runIndex, seed] of seeds.entries()) {
      const memoryView = renderMemoryViewForAgent(scenario.memoryGraph);
      const { result: assistantOutput, durationMs: agentLatencyMs } =
        await timed(() =>
          runnerOptions.agent.respond({
            scenarioId: scenario.id,
            prompt: scenario.scenarioPrompt,
            memoryView,
            seed,
            runIndex,
            runCount,
          }),
        );

      const { result: decision, durationMs: judgeLatencyMs } = await timed(
        () =>
          runSealedJudge(
            runnerOptions.judge,
            rubric,
            {
              taskId: `${scenario.id}#seed-${seed}`,
              scenario: scenario.scenarioPrompt,
              memorySummary: renderMemorySummaryForJudge(scenario.memoryGraph),
              assistantOutput,
            },
            { spotCheckLogger },
          ),
      );

      perSeedResults.push({
        seed,
        decision,
        agentLatencyMs,
        judgeLatencyMs,
        latencyMs: agentLatencyMs + judgeLatencyMs,
        assistantOutput,
      });
    }

    perScenarioRuns.push(perSeedResults);
    tasks.push(collapseScenario(scenario, perSeedResults, rubric));
  }

  const aggregates = buildAggregates(tasks);
  const statistics = buildStatistics(perScenarioRuns, runnerOptions.random);

  const remnicVersion = await getRemnicVersion();
  // `task.latencyMs` now holds the summed per-seed wall-clock for that
  // scenario, so the bench-level totals below roll up to real runtime.
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const totalSeedExecutions = tasks.length * runCount;

  return {
    meta: {
      id: randomUUID(),
      benchmark: definition.id,
      benchmarkTier: definition.tier,
      version: definition.meta.version,
      remnicVersion,
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode: resolved.mode,
      runCount,
      seeds,
    },
    config: {
      systemProvider: resolved.systemProvider ?? null,
      judgeProvider: resolved.judgeProvider ?? null,
      adapterMode: resolved.adapterMode ?? "direct",
      remnicConfig: {
        ...(resolved.remnicConfig ?? {}),
        assistantRubricId: rubric.id,
        assistantRubricSha256: rubric.sha256,
        assistantRunId: runId,
      },
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs,
      // Mean latency per seed execution (one agent call + one judge call),
      // which is the actual per-query unit of work in the Assistant tier.
      meanQueryLatencyMs:
        totalSeedExecutions > 0 ? totalLatencyMs / totalSeedExecutions : 0,
    },
    results: {
      tasks,
      aggregates,
      statistics,
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

function collapseScenario(
  scenario: AssistantScenario,
  perSeed: PerScenarioRunResult[],
  rubric: SealedRubric,
): TaskResult {
  const perDimensionMeans = meanPerDimension(perSeed);
  const perSeedScores = perSeed.map((run) => ({
    seed: run.seed,
    scores: run.decision.scores,
    parseOk: run.decision.parseOk,
    latencyMs: run.latencyMs,
    agentLatencyMs: run.agentLatencyMs,
    judgeLatencyMs: run.judgeLatencyMs,
    notes: run.decision.notes,
  }));

  const scores: Record<string, number> = {};
  for (const dimension of ASSISTANT_RUBRIC_DIMENSIONS) {
    scores[dimension] = perDimensionMeans[dimension];
  }
  const overall = ASSISTANT_RUBRIC_DIMENSIONS.reduce(
    (sum, dimension) => sum + scores[dimension]!,
    0,
  ) / ASSISTANT_RUBRIC_DIMENSIONS.length;
  scores.overall = roundScore(overall);

  // Report cumulative wall-clock per task (sum across seeds) so the
  // downstream `cost.totalLatencyMs = Σ task.latencyMs` aggregation in
  // `runAssistantBenchmark` reflects real runtime across seeded runs.
  // Under-reporting here makes multi-seed Assistant runs look artificially
  // cheap compared to their single-seed counterparts.
  const totalTaskLatencyMs = perSeed.reduce(
    (sum, run) => sum + run.latencyMs,
    0,
  );
  const meanSeedLatencyMs =
    perSeed.length > 0 ? Math.round(totalTaskLatencyMs / perSeed.length) : 0;

  return {
    taskId: scenario.id,
    question: scenario.scenarioPrompt,
    expected: "<rubric-judged>",
    actual: perSeed[0]?.assistantOutput ?? "",
    scores,
    latencyMs: totalTaskLatencyMs,
    tokens: { input: 0, output: 0 },
    details: {
      focus: scenario.focus,
      rubricId: rubric.id,
      rubricSha256: rubric.sha256,
      perSeedScores,
      meanSeedLatencyMs,
      judgeParseFailures: perSeedScores.filter((run) => !run.parseOk).length,
    },
  };
}

function meanPerDimension(
  runs: PerScenarioRunResult[],
): AssistantRubricScores {
  const sums: AssistantRubricScores = {
    identity_accuracy: 0,
    stance_coherence: 0,
    novelty: 0,
    calibration: 0,
  };
  if (runs.length === 0) return sums;

  for (const run of runs) {
    for (const dimension of ASSISTANT_RUBRIC_DIMENSIONS) {
      sums[dimension] += run.decision.scores[dimension];
    }
  }
  const means = {} as AssistantRubricScores;
  for (const dimension of ASSISTANT_RUBRIC_DIMENSIONS) {
    means[dimension] = roundScore(sums[dimension] / runs.length);
  }
  return means;
}

function buildAggregates(tasks: TaskResult[]): AggregateMetrics {
  return aggregateTaskScores(tasks.map((task) => task.scores));
}

function buildStatistics(
  perScenarioRuns: PerScenarioRunResult[][],
  random: (() => number) | undefined,
): StatisticalReport {
  const confidenceIntervals: Record<string, ConfidenceInterval> = {};

  for (const dimension of ASSISTANT_RUBRIC_DIMENSIONS) {
    const values = perSeedDimensionScores(perScenarioRuns, dimension);
    if (values.length === 0) continue;
    confidenceIntervals[dimension] = bootstrapMeanConfidenceInterval(values, {
      iterations: DEFAULT_BOOTSTRAP_ITERATIONS,
      random,
    });
  }

  const overallValues = perSeedOverallScores(perScenarioRuns);
  if (overallValues.length > 0) {
    confidenceIntervals.overall = bootstrapMeanConfidenceInterval(
      overallValues,
      { iterations: DEFAULT_BOOTSTRAP_ITERATIONS, random },
    );
  }

  return {
    confidenceIntervals,
    bootstrapSamples: DEFAULT_BOOTSTRAP_ITERATIONS,
  };
}

function perSeedDimensionScores(
  perScenarioRuns: PerScenarioRunResult[][],
  dimension: AssistantRubricDimension,
): number[] {
  const maxRunCount = Math.max(0, ...perScenarioRuns.map((runs) => runs.length));
  const values: number[] = [];
  for (let runIndex = 0; runIndex < maxRunCount; runIndex += 1) {
    const runScores = perScenarioRuns
      .map((runs) => runs[runIndex]?.decision.scores[dimension])
      .filter((score): score is number => typeof score === "number");
    if (runScores.length > 0) {
      values.push(runScores.reduce((sum, score) => sum + score, 0) / runScores.length);
    }
  }
  return values;
}

function perSeedOverallScores(
  perScenarioRuns: PerScenarioRunResult[][],
): number[] {
  const maxRunCount = Math.max(0, ...perScenarioRuns.map((runs) => runs.length));
  const values: number[] = [];
  for (let runIndex = 0; runIndex < maxRunCount; runIndex += 1) {
    const runScores = perScenarioRuns
      .map((runs) => {
        const run = runs[runIndex];
        if (!run) return undefined;
        return ASSISTANT_RUBRIC_DIMENSIONS.reduce(
          (sum, dimension) => sum + run.decision.scores[dimension],
          0,
        ) / ASSISTANT_RUBRIC_DIMENSIONS.length;
      })
      .filter((score): score is number => typeof score === "number");
    if (runScores.length > 0) {
      values.push(runScores.reduce((sum, score) => sum + score, 0) / runScores.length);
    }
  }
  return values;
}

function resolveSeeds(
  runnerOptions: AssistantRunnerOptions,
  resolved: ResolvedRunBenchmarkOptions,
): number[] {
  if (runnerOptions.seeds && runnerOptions.seeds.length > 0) {
    return [...runnerOptions.seeds];
  }
  const requested =
    runnerOptions.runCount ??
    (resolved.mode === "quick" ? 2 : DEFAULT_RUN_COUNT);
  // Delegate to the shared helper so seed-sequence generation stays in one
  // place; `buildBenchmarkRunSeeds` also validates the runCount / baseSeed
  // inputs.
  return buildBenchmarkRunSeeds(requested, resolved.seed);
}

function buildRunId(benchmarkId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${benchmarkId}-${ts}`;
}

function renderMemoryViewForAgent(graph: AssistantMemoryGraph): string {
  const lines: string[] = [];
  lines.push(`You are assisting ${graph.userHandle}, ${graph.userRole}.`);
  if (graph.currentDate) {
    lines.push(`Current date: ${graph.currentDate}.`);
  }
  lines.push("");
  lines.push("Recent memory items:");
  for (const fact of graph.facts) {
    lines.push(`- [${fact.id}] ${fact.summary}`);
  }
  if (graph.stances.length > 0) {
    lines.push("");
    lines.push("Stated positions:");
    for (const stance of graph.stances) {
      lines.push(`- ${stance.topic}: ${stance.position}`);
    }
  }
  if (graph.openThreads.length > 0) {
    lines.push("");
    lines.push("Open threads:");
    for (const thread of graph.openThreads) {
      lines.push(`- ${thread}`);
    }
  }
  return lines.join("\n");
}

function renderMemorySummaryForJudge(
  graph: AssistantMemoryGraph,
): string {
  const sections: string[] = [];
  sections.push(
    `USER: ${graph.userHandle} (${graph.userRole})`,
  );
  if (graph.currentDate) {
    sections.push(`CURRENT_DATE: ${graph.currentDate}`);
  }
  const facts = graph.facts
    .map((fact) => {
      const tags = Array.isArray(fact.tags) && fact.tags.length > 0
        ? ` [tags: ${fact.tags.join(", ")}]`
        : "";
      return `  - ${fact.id}: ${fact.summary}${tags}`;
    })
    .join("\n");
  if (facts.length > 0) sections.push(`FACTS:\n${facts}`);
  if (graph.stances.length > 0) {
    const stances = graph.stances
      .map((stance) => `  - ${stance.topic} => ${stance.position}`)
      .join("\n");
    sections.push(`STANCES:\n${stances}`);
  }
  if (graph.openThreads.length > 0) {
    sections.push(
      `OPEN_THREADS:\n${graph.openThreads
        .map((thread) => `  - ${thread}`)
        .join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export { renderMemoryViewForAgent, renderMemorySummaryForJudge };
export type { AssistantRubricDimension };
