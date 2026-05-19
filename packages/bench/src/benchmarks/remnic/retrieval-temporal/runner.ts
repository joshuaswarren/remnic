/**
 * Deterministic temporal retrieval benchmark over the schema-tier corpus.
 */

import { randomUUID } from "node:crypto";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import type { SchemaTierPage } from "../../../fixtures/schema-tiers/index.js";
import {
  buildTieredAggregates,
} from "../retrieval-shared.js";
import { extractRankedPageIds } from "../retrieval-page-ids.js";
import { buildSchemaTierMessages } from "../retrieval-schema-messages.js";
import {
  RETRIEVAL_TEMPORAL_FIXTURE,
  RETRIEVAL_TEMPORAL_SMOKE_FIXTURE,
  type RetrievalTemporalCase,
} from "./fixture.js";

export const retrievalTemporalDefinition: BenchmarkDefinition = {
  id: "retrieval-temporal",
  title: "Retrieval Temporal",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "retrieval-temporal",
    version: "1.0.0",
    description:
      "Deterministic clean-vs-dirty retrieval benchmark for temporal qrels under half-open windows.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #448",
  },
};

export async function runRetrievalTemporalBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const cases = loadCases(options.mode, options.limit);
  const tasks: TaskResult[] = [];

  for (const sample of cases) {
    validateHalfOpenWindow(sample.window.start, sample.window.end);
    validateExpectedPageIds(sample);
    const startedAt = performance.now();
    const sessionId = `retrieval-temporal:${sample.id}`;
    await options.system.reset(sessionId);
    await options.system.store(sessionId, buildSchemaTierMessages(sample.pages));
    await options.system.drain?.();
    const recallText = await options.system.recall(
      sessionId,
      sample.query,
      12_000,
      { asOf: sample.window.end },
    );
    const latencyMs = Math.round(performance.now() - startedAt);
    const retrievedPageIds = extractRankedPageIds(recallText, sample.pages);
    const topRetrievedPageIds = retrievedPageIds.slice(0, 5);
    const matchedPageIds = matchingPageIds(retrievedPageIds, sample);
    const expectedJson = JSON.stringify({
      expectedPageIds: sample.expectedPageIds,
      window: sample.window,
    });
    const actualJson = JSON.stringify({
      retrievedPageIds: topRetrievedPageIds,
      matchingPageIds: matchedPageIds,
    });

    tasks.push({
      taskId: sample.id,
      question: sample.title,
      expected: expectedJson,
      actual: actualJson,
      scores: {
        qrel_at_1: temporalQrelAtK(retrievedPageIds, sample, 1),
        qrel_at_3: temporalQrelAtK(retrievedPageIds, sample, 3),
        qrel_at_5: temporalQrelAtK(retrievedPageIds, sample, 5),
      },
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: {
        tier: sample.tier,
        window: sample.window,
        asOf: sample.window.end,
        recallLengthChars: recallText.length,
        retrievedPageIds: topRetrievedPageIds,
        matchingPageIds: matchedPageIds,
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
): RetrievalTemporalCase[] {
  const baseCases = mode === "quick"
    ? RETRIEVAL_TEMPORAL_SMOKE_FIXTURE
    : RETRIEVAL_TEMPORAL_FIXTURE;

  if (limit === undefined) {
    return baseCases;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("retrieval-temporal limit must be a positive integer");
  }

  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error("retrieval-temporal fixture is empty after applying the requested limit.");
  }
  return limited;
}

function temporalQrelAtK(
  rankedPageIds: string[],
  sample: RetrievalTemporalCase,
  k: number,
): number {
  const pageById = new Map(sample.pages.map((page) => [page.id, page]));
  const topK = rankedPageIds.slice(0, k);
  return topK.some((pageId) => {
    const page = pageById.get(pageId);
    return page ? pageQualifies(page, sample) : false;
  }) ? 1 : 0;
}

function pageQualifies(page: SchemaTierPage, sample: RetrievalTemporalCase): boolean {
  if (!sample.expectedPageIds.includes(page.id)) return false;
  return pageHasTemporalEvidenceInWindow(page, sample.window.start, sample.window.end);
}

function pageHasTemporalEvidenceInWindow(
  page: SchemaTierPage,
  startIso: string,
  endIso: string,
): boolean {
  const { startMs, endMs } = validateHalfOpenWindow(startIso, endIso);

  const evidenceTimestamps = collectEvidenceTimestamps(page);
  return evidenceTimestamps.some((timestamp) => timestamp >= startMs && timestamp < endMs);
}

function validateHalfOpenWindow(
  startIso: string,
  endIso: string,
): { startMs: number; endMs: number } {
  const startMs = parseStrictIsoTimestamp(startIso);
  const endMs = parseStrictIsoTimestamp(endIso);

  if (startMs === null || endMs === null || startMs >= endMs) {
    throw new Error("retrieval-temporal window must use valid half-open ISO timestamps");
  }

  return { startMs, endMs };
}

function validateExpectedPageIds(sample: RetrievalTemporalCase): void {
  const pageIds = new Set(sample.pages.map((page) => page.id));
  const missingPageIds = sample.expectedPageIds.filter((pageId) => !pageIds.has(pageId));

  if (missingPageIds.length > 0) {
    throw new Error(
      `retrieval-temporal expectedPageIds must reference pages present in the fixture: ${sample.id} -> ${missingPageIds.join(", ")}`,
    );
  }
}

function collectEvidenceTimestamps(page: SchemaTierPage): number[] {
  const timestamps = new Set<number>();

  const createdAt = parseTimestamp(page.createdAt);
  if (createdAt !== null) timestamps.add(createdAt);

  const created = parseTimestamp(page.frontmatter.created);
  if (created !== null) timestamps.add(created);

  for (const entry of page.frontmatter.timeline ?? []) {
    const timestamp = parseTimelineEntry(entry);
    if (timestamp !== null) timestamps.add(timestamp);
  }

  return [...timestamps];
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  return parseStrictIsoTimestamp(value);
}

function parseTimelineEntry(entry: string): number | null {
  const match = entry.match(/^(\d{4})-(\d{2})-(\d{2})(?=$|[:\s])/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date.getTime();
}

function parseStrictIsoTimestamp(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString() === value ? date.getTime() : null;
}

function matchingPageIds(
  rankedPageIds: string[],
  sample: RetrievalTemporalCase,
): string[] {
  const pageById = new Map(sample.pages.map((page) => [page.id, page]));
  return rankedPageIds.filter((pageId) => {
    const page = pageById.get(pageId);
    return page ? pageQualifies(page, sample) : false;
  });
}
