/**
 * Deterministic extraction-judge calibration benchmark.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  createVerdictCache,
  judgeFactDurability,
  parseConfig,
  type JudgeCandidate,
  type JudgeVerdict,
  type PluginConfig,
} from "@remnic/core";
import type { BenchmarkDefinition, BenchmarkResult, MetricAggregate, ResolvedRunBenchmarkOptions, TaskResult } from "../../../types.js";
import { aggregateTaskScores, exactMatch } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  EXTRACTION_JUDGE_CALIBRATION_FIXTURE,
  EXTRACTION_JUDGE_CALIBRATION_SMOKE_FIXTURE,
} from "./fixture.js";

export const extractionJudgeCalibrationDefinition: BenchmarkDefinition = {
  id: "extraction-judge-calibration",
  title: "Extraction Judge Calibration",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "extraction-judge-calibration",
    version: "1.0.0",
    description:
      "Synthetic durability-label benchmark for Remnic's extraction judge with deterministic mock LLM responses.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #445",
  },
};

export async function runExtractionJudgeCalibrationBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
    const cases = loadCases(options.mode, options.limit);
    const config = parseConfig({
      memoryDir: path.join(os.tmpdir(), "remnic-bench-extraction-judge"),
      workspaceDir: path.join(os.tmpdir(), "remnic-bench-extraction-judge-workspace"),
      openaiApiKey: "bench-test-key",
      extractionJudgeEnabled: true,
      extractionJudgeBatchSize: 4,
      extractionJudgeShadow: false,
    });
    const effectiveRemnicConfig = buildReportedRemnicConfig(config);
    const verdictCache = createVerdictCache();
    const deferCounts = new Map<string, number>();

    const localLlm = {
      chatCompletion: async (messages: Array<{ content: string }>) => {
        const payload = JSON.parse(messages.at(-1)?.content ?? "[]") as Array<{
          index: number;
          text: string;
          category: string;
          confidence: number;
        }>;

        const verdicts = payload.map((item) => ({
          index: item.index,
          durable: heuristicDurability(item.text, item.category, item.confidence),
          reason: heuristicReason(item.text, item.category, item.confidence),
        }));

        return {
          content: JSON.stringify(verdicts),
        };
      },
    };

    const startedAt = performance.now();
    const result = await judgeFactDurability(
      cases.map<JudgeCandidate>((sample) => ({
        text: sample.text,
        category: sample.category,
        confidence: sample.confidence,
        importanceLevel: sample.importanceLevel,
      })),
      config,
      localLlm as never,
      null,
      verdictCache,
      deferCounts,
    );
    const totalLatencyMs = Math.round(performance.now() - startedAt);

    const tasks = cases.map<TaskResult>((sample, index) => {
      const verdict = result.verdicts.get(index) ?? defaultVerdict();
      const predicted = verdict.durable ? "durable" : "reject";
      const expected = sample.expectedDurable ? "durable" : "reject";

      return {
        taskId: sample.id,
        question: sample.text,
        expected,
        actual: predicted,
        scores: {
          exact_match: exactMatch(predicted, expected),
        },
        latencyMs: Math.round(totalLatencyMs / Math.max(cases.length, 1)),
        tokens: { input: 0, output: 0 },
        details: {
          category: sample.category,
          confidence: sample.confidence,
          expectedDurable: sample.expectedDurable,
          reason: verdict.reason,
        },
      };
    });

    const confusion = buildConfusion(tasks);
    const aggregates = {
      ...aggregateTaskScores(tasks.map((task) => task.scores)),
      sensitivity: constantAggregate(ratioOrNeutral(confusion.truePositive, confusion.truePositive + confusion.falseNegative)),
      specificity: constantAggregate(ratioOrNeutral(confusion.trueNegative, confusion.trueNegative + confusion.falsePositive)),
      durable_precision: constantAggregate(ratioOrNeutral(confusion.truePositive, confusion.truePositive + confusion.falsePositive)),
    };

    const remnicVersion = await getRemnicVersion();

    return {
      meta: {
        id: randomUUID(),
        benchmark: options.benchmark.id,
        benchmarkTier: options.benchmark.tier,
        version: options.benchmark.meta.version,
        remnicVersion,
        gitSha: getGitSha(),
        timestamp: new Date().toISOString(),
        mode: options.mode,
        runCount: 1,
        seeds: [options.seed ?? 0],
      },
      config: {
        systemProvider: options.systemProvider ?? null,
        judgeProvider: options.judgeProvider ?? null,
        adapterMode: options.adapterMode ?? "direct",
        remnicConfig: effectiveRemnicConfig,
      },
      cost: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        totalLatencyMs,
        meanQueryLatencyMs: tasks.length > 0 ? totalLatencyMs / tasks.length : 0,
      },
      results: {
        tasks,
        aggregates,
      },
      environment: {
        os: process.platform,
        nodeVersion: process.version,
        hardware: process.arch,
      },
    };
}

function buildReportedRemnicConfig(
  config: PluginConfig,
): Record<string, unknown> {
  return {
    extractionJudgeEnabled: config.extractionJudgeEnabled,
    extractionJudgeBatchSize: config.extractionJudgeBatchSize,
    extractionJudgeShadow: config.extractionJudgeShadow,
    extractionJudgeMaxDeferrals: config.extractionJudgeMaxDeferrals,
    extractionJudgeModel: config.extractionJudgeModel,
  };
}

function loadCases(
  mode: "quick" | "full",
  limit?: number,
) {
  const baseCases = mode === "quick"
    ? EXTRACTION_JUDGE_CALIBRATION_SMOKE_FIXTURE
    : EXTRACTION_JUDGE_CALIBRATION_FIXTURE;

  if (limit === undefined) {
    return baseCases;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("extraction-judge-calibration limit must be a positive integer");
  }

  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error(
      "extraction-judge-calibration fixture is empty after applying the requested limit.",
    );
  }
  return limited;
}

function heuristicDurability(
  text: string,
  category: string,
  confidence: number,
): boolean {
  const normalized = text.toLowerCase();
  if (category === "correction" || category === "principle") {
    return true;
  }

  const durableSignals = [
    "prefer",
    "always",
    "deadline",
    "decided",
    "my name is",
    "works",
    "project",
  ];
  const transientSignals = [
    "currently",
    "right now",
    "for this task",
    "click the third tab",
    "thanks",
    "running",
    "line 42",
  ];

  if (transientSignals.some((signal) => normalized.includes(signal))) {
    return false;
  }

  if (durableSignals.some((signal) => normalized.includes(signal))) {
    return true;
  }

  return confidence >= 0.85;
}

function heuristicReason(
  text: string,
  category: string,
  confidence: number,
): string {
  if (category === "correction") return "Correction bypass";
  if (category === "principle") return "Principle bypass";
  if (heuristicDurability(text, category, confidence)) return "Heuristic durable signal";
  return "Heuristic transient signal";
}

function defaultVerdict(): JudgeVerdict {
  return {
    durable: true,
    reason: "Approved by default (judge unavailable or parse error)",
  };
}

function buildConfusion(tasks: TaskResult[]) {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;

  for (const task of tasks) {
    const predictedDurable = task.actual === "durable";
    const expectedDurable = task.expected === "durable";

    if (predictedDurable && expectedDurable) truePositive += 1;
    else if (!predictedDurable && !expectedDurable) trueNegative += 1;
    else if (predictedDurable) falsePositive += 1;
    else falseNegative += 1;
  }

  return { truePositive, trueNegative, falsePositive, falseNegative };
}

function ratioOrNeutral(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function constantAggregate(value: number): MetricAggregate {
  return {
    mean: value,
    median: value,
    stdDev: 0,
    min: value,
    max: value,
  };
}
