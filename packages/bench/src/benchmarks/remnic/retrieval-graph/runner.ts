/**
 * Graph retrieval A/B benchmark (issue #559 PR 5).
 *
 * Runs every case twice — once with graph-on (PPR over the extracted
 * edge graph) and once with graph-off (lexical / id-match only) — and
 * reports precision@K for both. The result JSON carries both columns
 * so downstream analysis can judge whether graph-on wins, ties, or
 * loses before the default flag gets flipped.
 *
 * Pure bench — no I/O, no config, no external services. All inputs are
 * declared in `fixture.ts`.
 */

import { randomUUID } from "node:crypto";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { aggregateTaskScores, precisionAtK } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  buildGraphFromMemories,
  queryGraph,
  type MemoryEdgeSource,
  type RankedGraphNode,
} from "@remnic/core";
import {
  RETRIEVAL_GRAPH_FIXTURE,
  RETRIEVAL_GRAPH_SMOKE_FIXTURE,
  type GraphBenchCase,
} from "./fixture.js";

export const retrievalGraphDefinition: BenchmarkDefinition = {
  id: "retrieval-graph",
  title: "Retrieval Graph (PPR A/B)",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "retrieval-graph",
    version: "1.0.0",
    description:
      "A/B benchmark comparing graph-on (PPR) vs graph-off (lexical-only) " +
      "retrieval on a multi-hop synthetic fixture. Measures whether graph " +
      "retrieval improves recall on memories reachable only through edges.",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #559 PR 5.",
  },
};

export async function runRetrievalGraphBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const cases = loadCases(options.mode, options.limit);
  const tasks: TaskResult[] = [];
  let totalOn = 0;
  let totalOff = 0;
  let ties = 0;
  let wins = 0;
  let losses = 0;

  for (const sample of cases) {
    const startedAt = performance.now();

    const off = recallOff(sample);
    const on = recallOn(sample);

    const pOn = precisionAtK(on, sample.expectedIds, 3);
    const pOff = precisionAtK(off, sample.expectedIds, 3);
    totalOn += pOn;
    totalOff += pOff;
    if (pOn > pOff) wins += 1;
    else if (pOn < pOff) losses += 1;
    else ties += 1;

    const latencyMs = Math.round(performance.now() - startedAt);

    const delta_p_at_3 = pOn - pOff;
    tasks.push({
      taskId: sample.id,
      question: sample.title,
      expected: JSON.stringify(sample.expectedIds),
      actual: JSON.stringify(on.slice(0, 5)),
      scores: {
        p_at_1_on: precisionAtK(on, sample.expectedIds, 1),
        p_at_3_on: pOn,
        p_at_5_on: precisionAtK(on, sample.expectedIds, 5),
        p_at_1_off: precisionAtK(off, sample.expectedIds, 1),
        p_at_3_off: pOff,
        p_at_5_off: precisionAtK(off, sample.expectedIds, 5),
        delta_p_at_3,
        // 1 for graph-on win, 0 for tie, -1 for graph-on loss.
        graph_on_win: pOn > pOff ? 1 : pOn < pOff ? -1 : 0,
      },
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: {
        description: sample.description,
        seedIds: sample.seedIds,
        graphOnTop5: on.slice(0, 5),
        graphOffTop5: off.slice(0, 5),
      },
    });
  }

  const remnicVersion = await getRemnicVersion();
  const totalLatencyMs = tasks.reduce((sum, task) => sum + task.latencyMs, 0);

  const meanOn = tasks.length > 0 ? totalOn / tasks.length : 0;
  const meanOff = tasks.length > 0 ? totalOff / tasks.length : 0;

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
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}

function recallOff(sample: GraphBenchCase): string[] {
  return [...sample.seedIds];
}

function recallOn(sample: GraphBenchCase): string[] {
  const graph = buildGraphFromMemories(sample.memories);
  const result = queryGraph(graph, sample.seedIds, {
    damping: 0.85,
    iterations: 30,
  });
  const out: string[] = [];
  for (const node of result.rankedNodes as RankedGraphNode[]) {
    const graphNode = graph.nodes.get(node.id);
    if (graphNode?.type === "memory") out.push(node.id);
  }
  return out;
}

function loadCases(
  mode: "quick" | "full",
  limit?: number,
): GraphBenchCase[] {
  const baseCases =
    mode === "quick" ? RETRIEVAL_GRAPH_SMOKE_FIXTURE : RETRIEVAL_GRAPH_FIXTURE;

  if (limit === undefined) return baseCases;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("retrieval-graph limit must be a positive integer");
  }
  const limited = baseCases.slice(0, limit);
  if (limited.length === 0) {
    throw new Error("retrieval-graph fixture is empty after applying the requested limit.");
  }
  return limited;
}

export type { MemoryEdgeSource };
