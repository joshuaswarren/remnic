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
import type { SchemaTierPage } from "../../../fixtures/schema-tiers/index.js";
import {
  buildTieredAggregates,
  overlapCount,
} from "../retrieval-shared.js";
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
    const rankedPageIds = rankPages(sample.query, sample.pages).map((page) => page.id);
    const latencyMs = Math.round(performance.now() - startedAt);
    const expectedJson = JSON.stringify(sample.expectedPageIds);
    const actualJson = JSON.stringify(rankedPageIds.slice(0, 5));

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
        retrievedPageIds: rankedPageIds.slice(0, 5),
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

function rankPages(query: string, pages: SchemaTierPage[]): SchemaTierPage[] {
  return [...pages].sort((left, right) => {
    const scoreDelta = scorePage(query, right) - scorePage(query, left);
    if (scoreDelta !== 0) return scoreDelta;
    return left.id.localeCompare(right.id);
  });
}

function scorePage(query: string, page: SchemaTierPage): number {
  const queryTokens = tokenize(query);
  const ownerHit = queryTokens.has(page.owner.toLowerCase()) ? 3 : 0;
  const titleScore = overlapCount(queryTokens, tokenize(page.title)) * 4;
  const canonicalTitleScore = overlapCount(queryTokens, tokenize(page.canonicalTitle)) * 3;
  const aliasScore = overlapCount(queryTokens, tokenize(page.aliases.join(" "))) * 2;
  const bodyScore = overlapCount(queryTokens, tokenize(page.body)) * 2;
  const timelineScore = overlapCount(queryTokens, tokenize(page.timeline.join(" "))) * 1.5;
  const penalty = schemaPenalty(queryTokens, page);

  return ownerHit + titleScore + canonicalTitleScore + aliasScore + bodyScore + timelineScore - penalty;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map(normalizeRetrievalToken)
      .filter((token): token is string => token !== undefined),
  );
}

function normalizeRetrievalToken(token: string): string | undefined {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length < 3 && !/[0-9]/.test(trimmed)) {
    return undefined;
  }
  if (/^decid(?:e|es|ed|ing)$/.test(trimmed) || /^decisions?$/.test(trimmed)) {
    return "decide";
  }
  return trimmed;
}

function schemaPenalty(queryTokens: Set<string>, page: SchemaTierPage): number {
  let penalty = 0;

  if (page.title !== page.canonicalTitle) penalty += 2;
  if (!page.frontmatter.type) penalty += 2.5;
  if (!page.frontmatter.created) penalty += 1;
  if (page.timeline.length === 0) penalty += 1;
  if (page.type === "project" && page.seeAlso.length < 2) penalty += 1.5;
  if (queryTokens.has("decide") && !page.frontmatter.type) {
    penalty += 3;
  }

  return penalty;
}
