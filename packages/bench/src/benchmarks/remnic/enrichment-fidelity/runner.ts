/**
 * Deterministic enrichment pipeline benchmark.
 */

import { randomUUID } from "node:crypto";
import { EnrichmentProviderRegistry, runEnrichmentPipeline, type EnrichmentProvider } from "@remnic/core";
import type { BenchmarkDefinition, BenchmarkResult, MetricAggregate, ResolvedRunBenchmarkOptions, TaskResult } from "../../../types.js";
import { aggregateTaskScores } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  ENRICHMENT_FIDELITY_FIXTURE,
  ENRICHMENT_FIDELITY_SMOKE_FIXTURE,
} from "./fixture.js";

const NOOP_LOG = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export const enrichmentFidelityDefinition: BenchmarkDefinition = {
  id: "enrichment-fidelity",
  title: "Enrichment Fidelity",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "enrichment-fidelity",
    version: "1.0.0",
    description:
      "Synthetic enrichment benchmark covering provider selection, caps, and accepted-candidate precision.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #445",
  },
};

export async function runEnrichmentFidelityBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const cases = loadCases(options.mode, options.limit);
  const tasks: TaskResult[] = [];

  for (const sample of cases) {
    const registry = new EnrichmentProviderRegistry();
    for (const provider of sample.providers) {
      registry.register({
        id: provider.id,
        costTier: provider.costTier,
        async enrich() {
          return provider.candidates;
        },
        async isAvailable() {
          return provider.available ?? true;
        },
      } satisfies EnrichmentProvider);
    }

    const startedAt = performance.now();
    const results = await runEnrichmentPipeline(
      [sample.entity],
      registry,
      sample.config,
      NOOP_LOG,
    );
    const latencyMs = Math.round(performance.now() - startedAt);

    const acceptedTexts = results
      .flatMap((result) => result.acceptedCandidates)
      .map((candidate) => candidate.text);
    const expectedSet = new Set(sample.expectedAccepted.map(normalizeText));
    const actualSet = new Set(acceptedTexts.map(normalizeText));
    const overlapCount = [...actualSet].filter((text) => expectedSet.has(text)).length;

    tasks.push({
      taskId: sample.id,
      question: `Enrich ${sample.entity.name}`,
      expected: sample.expectedAccepted.join("\n"),
      actual: acceptedTexts.join("\n"),
      scores: {
        accepted_precision: ratio(overlapCount, actualSet.size),
        accepted_recall: ratio(overlapCount, expectedSet.size),
        exact_count_match: sample.expectedAccepted.length === acceptedTexts.length ? 1 : 0,
      },
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: {
        importanceLevel: sample.entity.importanceLevel,
        providers: sample.providers.map((provider) => provider.id),
        results,
      },
    });
    options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, cases.length);
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);
  const aggregates = aggregateTaskScores(tasks.map((task) => task.scores));
  const globalPrecision = ratio(
    tasks.reduce(
      (sum, task) =>
        sum +
        [...new Set(task.actual.split("\n").filter(Boolean).map(normalizeText))]
          .filter((text) =>
            new Set(task.expected.split("\n").filter(Boolean).map(normalizeText)).has(text),
          ).length,
      0,
    ),
    tasks.reduce(
      (sum, task) => sum + new Set(task.actual.split("\n").filter(Boolean).map(normalizeText)).size,
      0,
    ),
  );

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
      remnicConfig: options.remnicConfig ?? {},
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
      aggregates: {
        ...aggregates,
        overall_precision: constantAggregate(globalPrecision),
      },
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
    ? ENRICHMENT_FIDELITY_SMOKE_FIXTURE
    : ENRICHMENT_FIDELITY_FIXTURE;

  if (limit === undefined) {
    return baseCases;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("enrichment-fidelity limit must be a positive integer");
  }

  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error("enrichment-fidelity fixture is empty after applying the requested limit.");
  }
  return limited;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function ratio(numerator: number, denominator: number): number {
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
