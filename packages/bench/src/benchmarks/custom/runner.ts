/**
 * Custom benchmark runner.
 */

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RunBenchmarkOptions, BenchmarkDefinition, BenchmarkResult, ResolvedRunBenchmarkOptions, TaskResult } from "../../types.js";
import { answerBenchmarkQuestion } from "../../answering.js";
import { aggregateTaskScores, exactMatch, f1Score, llmJudgeScoreDetailed, rougeL, timed } from "../../scorer.js";
import { orchestrateBenchmarkRuns, resolveBenchmarkRunCount } from "../../benchmark.js";
import { finalizeBenchmarkResultConfig } from "../../result-config.js";
import { getGitSha, getRemnicVersion } from "../../reporter.js";
import { loadCustomBenchmarkFile } from "./loader.js";
import type { CustomBenchmarkScoring, CustomBenchmarkSpec } from "./types.js";

export async function runCustomBenchmarkFile(
  filePath: string,
  options: RunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const spec = await loadCustomBenchmarkFile(filePath);
  const benchmark = createCustomBenchmarkDefinition(spec, filePath);
  return runCustomBenchmark(spec, {
    ...options,
    mode: options.mode ?? "quick",
    benchmark,
  });
}

async function runCustomBenchmark(
  spec: CustomBenchmarkSpec,
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  if (spec.scoring === "llm_judge" && !options.system.judge) {
    throw new Error(
      `Custom benchmark "${spec.name}" uses llm_judge scoring but no judge provider is configured.`,
    );
  }

  const runCount = resolveBenchmarkRunCount(options.mode, options.iterations);
  const tasksPerRun = selectTasks(spec, options.limit);
  const totalTaskCount = runCount * tasksPerRun.length;
  let completedTaskCount = 0;
  const { seeds, runs } = await orchestrateBenchmarkRuns(
    options.mode,
    async (seed, runIndex) =>
      runCustomBenchmarkRun(
        spec,
        options,
        seed,
        runIndex,
        tasksPerRun,
        (taskResult) => {
          completedTaskCount += 1;
          options.onTaskComplete?.(taskResult, completedTaskCount, totalTaskCount);
        },
      ),
    options.iterations,
    options.seed,
  );
  const tasks = runs.flat();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const totalInputTokens = tasks.reduce((sum, task) => sum + task.tokens.input, 0);
  const totalOutputTokens = tasks.reduce((sum, task) => sum + task.tokens.output, 0);

  return finalizeBenchmarkResultConfig({
    meta: {
      id: randomUUID(),
      benchmark: options.benchmark.id,
      benchmarkTier: options.benchmark.tier,
      version: options.benchmark.meta.version,
      remnicVersion: await getRemnicVersion(),
      gitSha: getGitSha(),
      timestamp: new Date().toISOString(),
      mode: options.mode,
      runCount,
      seeds,
    },
    config: {
      systemProvider: options.systemProvider ?? null,
      judgeProvider: options.judgeProvider ?? null,
      adapterMode: options.adapterMode ?? "direct",
      remnicConfig: options.remnicConfig ?? {},
    },
    cost: {
      totalTokens: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
    },
    results: {
      tasks,
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  }, options);
}

async function runCustomBenchmarkRun(
  benchmark: CustomBenchmarkSpec,
  options: ResolvedRunBenchmarkOptions,
  seed: number,
  runIndex: number,
  tasks: readonly CustomBenchmarkSpec["tasks"][number][],
  onTaskComplete?: (task: TaskResult) => void,
): Promise<TaskResult[]> {
  const results: TaskResult[] = [];
  for (const [taskIndex, task] of tasks.entries()) {
    const { result: searchResults, durationMs } = await timed(async () =>
      options.system.search(task.question, 10),
    );
    const recalledText = searchResults.map((entry) => entry.snippet).join("\n\n");
    const answered = await answerBenchmarkQuestion({
      question: task.question,
      recalledText,
      responder: options.system.responder,
    });
    const scored = await scoreTask(
      benchmark.scoring,
      options,
      task.question,
      answered.finalAnswer,
      task.expected,
    );

    const taskResult: TaskResult = {
      taskId: `${slugify(benchmark.name)}-${runIndex + 1}-${taskIndex + 1}`,
      question: task.question,
      expected: task.expected,
      actual: answered.finalAnswer,
      scores: { [benchmark.scoring]: scored.score },
      latencyMs: durationMs + answered.latencyMs + scored.judgeMetrics.latencyMs,
      tokens: {
        input: answered.tokens.input + scored.judgeMetrics.tokens.input,
        output: answered.tokens.output + scored.judgeMetrics.tokens.output,
      },
      details: {
        tags: task.tags ?? [],
        searchHits: searchResults.length,
        scoring: benchmark.scoring,
        runIndex,
        seed,
        recalledLength: recalledText.length,
        answeredLength: answered.finalAnswer.length,
        recalledText,
        answeredText: answered.finalAnswer,
        responderModel: answered.model,
        judgeModel: scored.judgeMetrics.model,
      },
    };
    results.push(taskResult);
    onTaskComplete?.(taskResult);
  }

  return results;
}

function selectTasks(
  benchmark: CustomBenchmarkSpec,
  limit: number | undefined,
): readonly CustomBenchmarkSpec["tasks"][number][] {
  const tasks = benchmark.tasks.slice(0, normalizeLimit(limit) ?? benchmark.tasks.length);
  if (tasks.length === 0) {
    throw new Error(
      `Custom benchmark "${benchmark.name}" is empty after applying the requested limit.`,
    );
  }

  return tasks;
}

async function scoreTask(
  scoring: CustomBenchmarkScoring,
  options: ResolvedRunBenchmarkOptions,
  question: string,
  actual: string,
  expected: string,
): Promise<{
  score: number;
  judgeMetrics: {
    score: number;
    tokens: { input: number; output: number };
    latencyMs: number;
    model?: string;
  };
}> {
  switch (scoring) {
    case "exact_match":
      return {
        score: exactMatch(actual, expected),
        judgeMetrics: { score: -1, tokens: { input: 0, output: 0 }, latencyMs: 0 },
      };
    case "f1":
      return {
        score: f1Score(actual, expected),
        judgeMetrics: { score: -1, tokens: { input: 0, output: 0 }, latencyMs: 0 },
      };
    case "rouge_l":
      return {
        score: rougeL(actual, expected),
        judgeMetrics: { score: -1, tokens: { input: 0, output: 0 }, latencyMs: 0 },
      };
    case "llm_judge":
      const judgeMetrics = await llmJudgeScoreDetailed(
        options.system.judge,
        question,
        actual,
        expected,
      );
      return {
        score: judgeMetrics.score,
        judgeMetrics,
      };
    default:
      throw new Error(`Unsupported custom benchmark scoring: ${scoring as string}`);
  }
}

function createCustomBenchmarkDefinition(
  benchmark: CustomBenchmarkSpec,
  filePath: string,
): BenchmarkDefinition {
  const id = `custom:${slugify(path.basename(filePath, path.extname(filePath)) || benchmark.name)}`;
  return {
    id,
    title: benchmark.name,
    tier: "custom",
    status: "ready",
    runnerAvailable: true,
    meta: {
      name: benchmark.name,
      version: benchmark.version ?? "1.0.0",
      description: benchmark.description ?? "",
      category: benchmark.category ?? "retrieval",
      citation: benchmark.citation,
    },
  };
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(
      `Custom benchmark limit must be a non-negative integer when provided; received ${limit}.`,
    );
  }

  return limit;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-") || "custom-benchmark";
}
