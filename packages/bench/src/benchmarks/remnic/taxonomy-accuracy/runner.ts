/**
 * Deterministic taxonomy benchmark for Remnic's category resolver.
 */

import { randomUUID } from "node:crypto";
import { resolveCategory } from "@remnic/core";
import type { BenchmarkDefinition, BenchmarkResult, MetricAggregate, ResolvedRunBenchmarkOptions, TaskResult } from "../../../types.js";
import { aggregateTaskScores, exactMatch } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  TAXONOMY_ACCURACY_FIXTURE,
  TAXONOMY_ACCURACY_SMOKE_FIXTURE,
  TAXONOMY_ACCURACY_TAXONOMY,
} from "./fixture.js";

export const taxonomyAccuracyDefinition: BenchmarkDefinition = {
  id: "taxonomy-accuracy",
  title: "Taxonomy Accuracy",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "taxonomy-accuracy",
    version: "1.0.0",
    description:
      "Synthetic MECE taxonomy benchmark over overlapping category rules and deterministic tie-breaking.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #445",
  },
};

export async function runTaxonomyAccuracyBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const cases = loadCases(options.mode, options.limit);
  const tasks: TaskResult[] = [];

  for (const sample of cases) {
    const startedAt = performance.now();
    const decision = resolveCategory(
      sample.content,
      sample.memoryCategory,
      TAXONOMY_ACCURACY_TAXONOMY,
    );
    const latencyMs = Math.round(performance.now() - startedAt);

    const task: TaskResult = {
      taskId: sample.id,
      question: sample.content,
      expected: sample.expectedCategoryId,
      actual: decision.categoryId,
      scores: {
        exact_match: exactMatch(decision.categoryId, sample.expectedCategoryId),
        confidence: decision.confidence,
      },
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: {
        memoryCategory: sample.memoryCategory,
        reason: decision.reason,
        alternatives: decision.alternatives,
      },
    };
    tasks.push(task);
    options.onTaskComplete?.(task, tasks.length, cases.length);
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);

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
      remnicConfig: {
        ...(options.remnicConfig ?? {}),
        taxonomyVersion: TAXONOMY_ACCURACY_TAXONOMY.version,
      },
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
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

function loadCases(
  mode: "quick" | "full",
  limit?: number,
) {
  const baseCases = mode === "quick"
    ? TAXONOMY_ACCURACY_SMOKE_FIXTURE
    : TAXONOMY_ACCURACY_FIXTURE;

  if (limit === undefined) {
    return baseCases;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("taxonomy-accuracy limit must be a positive integer");
  }

  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error("taxonomy-accuracy fixture is empty after applying the requested limit.");
  }
  return limited;
}
