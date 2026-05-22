/**
 * Coding-agent recall benchmark (issue #569 PR 8).
 *
 * Measures whether the retrieval layer correctly honours the three #569
 * invariants: cross-project isolation, branch isolation with project
 * fallback, and review-context ranking. It also covers the developer
 * workflow memory shape Remnic should support for coding agents: repo
 * conventions, architecture patterns, tests, release process, past bugs,
 * common failure modes, review preferences, ask-before rules, and
 * always-run checks. The benchmark is deterministic — no LLM, no storage —
 * so it runs in CI without any daemon.
 */

import { randomUUID } from "node:crypto";

import { rankReviewCandidates } from "@remnic/core";

import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { aggregateTaskScores, precisionAtK } from "../../../scorer.js";
import {
  CODING_RECALL_FIXTURE,
  CODING_RECALL_SMOKE_FIXTURE,
  type CodingRecallCase,
  type CodingRecallCaseMemory,
  type DeveloperWorkflowFacet,
} from "./fixture.js";

export const codingRecallDefinition: BenchmarkDefinition = {
  id: "coding-recall",
  title: "Coding-Agent Recall (project/branch isolation + developer workflow)",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "coding-recall",
    version: "1.0.0",
    description:
      "Deterministic benchmark for coding-agent memory: project/branch namespace isolation, diff-aware review-context ranking, and developer workflow context.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #569",
  },
};

export async function runCodingRecallBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const cases = loadCases(options.mode, options.limit);
  const tasks: TaskResult[] = [];

  for (const sample of cases) {
    const startedAt = performance.now();
    const retrieved = scoreCase(sample);
    const latencyMs = Math.round(performance.now() - startedAt);
    const expectedJson = JSON.stringify(sample.expectedIds);
    const actualJson = JSON.stringify(retrieved.map((m) => m.id));

    // Precision@k against the ordered expected list.
    const retrievedIds = retrieved.map((m) => m.id);

    // Isolation metric — 1.0 when no forbidden id leaks, 0.0 on any leak.
    const leaked = retrievedIds.filter((id) => sample.forbiddenIds.includes(id));
    const isolationScore = leaked.length === 0 ? 1 : 0;
    const requiredWorkflowFacets = sample.requiredWorkflowFacets ?? [];
    const retrievedWorkflowFacets = collectWorkflowFacets(retrieved);
    const missingWorkflowFacets = requiredWorkflowFacets.filter(
      (facet) => !retrievedWorkflowFacets.includes(facet),
    );
    const scores: Record<string, number> = {
      p_at_1: precisionAtK(retrievedIds, sample.expectedIds, 1),
      p_at_3: precisionAtK(retrievedIds, sample.expectedIds, 3),
      p_at_5: precisionAtK(retrievedIds, sample.expectedIds, 5),
      isolation: isolationScore,
    };
    const details: Record<string, unknown> = {
      kind: sample.kind,
      sessionNamespaces: sample.sessionNamespaces,
      forbiddenIds: sample.forbiddenIds,
      leaked,
      retrievedIds,
    };

    if (requiredWorkflowFacets.length > 0) {
      scores.workflow_coverage =
        (requiredWorkflowFacets.length - missingWorkflowFacets.length) /
        requiredWorkflowFacets.length;
      details.requiredWorkflowFacets = requiredWorkflowFacets;
      details.retrievedWorkflowFacets = retrievedWorkflowFacets;
      details.missingWorkflowFacets = missingWorkflowFacets;
    }

    const task: TaskResult = {
      taskId: sample.id,
      question: sample.title,
      expected: expectedJson,
      actual: actualJson,
      scores,
      latencyMs,
      tokens: { input: 0, output: 0 },
      details,
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
      aggregates: aggregateTaskScores(tasks.map((t) => t.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Scoring
// ──────────────────────────────────────────────────────────────────────────
//
// The benchmark delegates the actual review-context ranking logic to
// `@remnic/core`'s `rankReviewCandidates` so that the benchmark verdict
// exercises the SAME code path production does. Previously the benchmark
// reimplemented the boost + sort logic locally and could have diverged from
// the shipped behavior; now an accidental change to production ranking
// would be caught by the benchmark instead of hidden by a parallel copy.

function scoreCase(sample: CodingRecallCase): CodingRecallCaseMemory[] {
  // 1. Filter candidates to the session's readable namespaces (rule 42).
  const allowedNs = new Set(sample.sessionNamespaces);
  const filtered = sample.candidates.filter((c) => allowedNs.has(c.namespace));

  // 2. Delegate review-context boosting + deterministic ordering to the
  //    canonical production ranker. When no touched files are supplied the
  //    boost is 0 for every candidate and the original sort order is
  //    preserved with the stable-id tiebreak.
  const touched = sample.touchedFiles ?? [];
  const ranked = rankReviewCandidates(
    filtered.map((c) => ({ id: c.id, score: c.score, entityRefs: c.entityRefs })),
    touched,
  );

  // 3. Re-project the candidate back to the benchmark's result shape
  //    (rankReviewCandidates returns only the subset it needs).
  const byId = new Map(filtered.map((c) => [c.id, c]));
  return ranked
    .map((r) => byId.get(r.id))
    .filter((c): c is CodingRecallCaseMemory => c !== undefined);
}

function collectWorkflowFacets(
  memories: CodingRecallCaseMemory[],
): DeveloperWorkflowFacet[] {
  return Array.from(
    new Set(memories.flatMap((memory) => memory.workflowFacets ?? [])),
  ).sort();
}

// ──────────────────────────────────────────────────────────────────────────
// Fixture selection
// ──────────────────────────────────────────────────────────────────────────

function loadCases(
  mode: "quick" | "full",
  limit?: number,
): CodingRecallCase[] {
  const baseCases = mode === "quick" ? CODING_RECALL_SMOKE_FIXTURE : CODING_RECALL_FIXTURE;

  if (limit === undefined) return baseCases;

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("coding-recall limit must be a positive integer");
  }
  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error("coding-recall fixture is empty after applying the requested limit.");
  }
  return limited;
}
