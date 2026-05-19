/**
 * Deterministic personalization retrieval benchmark over the schema-tier corpus.
 */

import { randomUUID } from "node:crypto";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { precisionAtK } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  buildTieredAggregates,
} from "../retrieval-shared.js";
import { extractRankedPageIds } from "../retrieval-page-ids.js";
import { buildSchemaTierMessages } from "../retrieval-schema-messages.js";
import {
  RETRIEVAL_PERSONALIZATION_FIXTURE,
  RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE,
  type RetrievalPersonalizationCase,
} from "./fixture.js";

export const retrievalPersonalizationDefinition: BenchmarkDefinition = {
  id: "retrieval-personalization",
  title: "Retrieval Personalization",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "retrieval-personalization",
    version: "1.0.0",
    description:
      "Deterministic clean-vs-dirty retrieval benchmark for personal-scope ranking precision.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #448",
  },
};

export async function runRetrievalPersonalizationBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const cases = loadCases(options.mode, options.limit);
  const tasks: TaskResult[] = [];

  for (const sample of cases) {
    const startedAt = performance.now();
    const sessionId = `retrieval-personalization:${sample.id}`;
    await options.system.reset(sessionId);
    await options.system.store(sessionId, buildSchemaTierMessages(sample.pages));
    await options.system.drain?.();
    const recallText = await options.system.recall(sessionId, sample.query, 12_000);
    const latencyMs = Math.round(performance.now() - startedAt);
    const rankedPageIds = extractRankedPageIds(recallText, sample.pages);
    const topRetrievedPageIds = rankedPageIds.slice(0, 5);
    const expectedJson = JSON.stringify(sample.expectedPageIds);
    const actualJson = JSON.stringify(topRetrievedPageIds);

    tasks.push({
      taskId: sample.id,
      question: sample.title,
      expected: expectedJson,
      actual: actualJson,
      scores: {
        p_at_1: precisionAtK(rankedPageIds, sample.expectedPageIds, 1),
        p_at_3: precisionAtK(rankedPageIds, sample.expectedPageIds, 3),
        p_at_5: precisionAtK(rankedPageIds, sample.expectedPageIds, 5),
      },
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: {
        tier: sample.tier,
        expectedOwner: sample.expectedOwner,
        expectedNamespace: sample.expectedNamespace,
        recallLengthChars: recallText.length,
        retrievedPageIds: topRetrievedPageIds,
      },
    });
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
      aggregates: buildTieredAggregates(tasks),
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
): RetrievalPersonalizationCase[] {
  const baseCases = mode === "quick"
    ? RETRIEVAL_PERSONALIZATION_SMOKE_FIXTURE
    : RETRIEVAL_PERSONALIZATION_FIXTURE;

  if (limit === undefined) {
    return baseCases;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("retrieval-personalization limit must be a positive integer");
  }

  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error("retrieval-personalization fixture is empty after applying the requested limit.");
  }
  return limited;
}
