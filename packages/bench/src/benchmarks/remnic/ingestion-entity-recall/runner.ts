/**
 * Ingestion entity recall benchmark.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
  TaskResult,
} from "../../../types.js";
import { entityRecall } from "../../../ingestion-scorer.js";
import { aggregateTaskScores, timed } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { emailFixture } from "../../../fixtures/inbox/email.js";

export const ingestionEntityRecallDefinition: BenchmarkDefinition = {
  id: "ingestion-entity-recall",
  title: "Ingestion: Entity Recall",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ingestion-entity-recall",
    version: "1.0.0",
    description: "Measures entity extraction recall against a curated gold graph after ingesting synthetic inbox data.",
    category: "ingestion",
  },
};

export async function runIngestionEntityRecallBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  if (!options.ingestionAdapter) {
    throw new Error("ingestionAdapter is required for ingestion benchmarks");
  }
  const fixture = emailFixture.generate();

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "bench-email-"));
  try {
    await options.ingestionAdapter!.reset();

    for (const file of fixture.files) {
      const filePath = path.join(fixtureDir, file.relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    const { result: ingestionLog, durationMs } = await timed(async () =>
      options.ingestionAdapter!.ingest(await realpath(fixtureDir)),
    );

    if (ingestionLog.errors.length > 0) {
      const message = ingestionLog.errors.join(" | ");
      const tasks: TaskResult[] = [
        {
          taskId: `entity-recall-${fixture.id}`,
          question: `Extract entities from ${fixture.id} fixture`,
          expected: `${fixture.goldGraph.entities.length} entities`,
          actual: `(ingestion error: ${message})`,
          scores: {
            entity_recall: -1,
          },
          latencyMs: durationMs,
          tokens: { input: 0, output: 0 },
          details: {
            fixtureId: fixture.id,
            goldEntityCount: fixture.goldGraph.entities.length,
            ingestionErrors: ingestionLog.errors,
            commandsIssued: ingestionLog.commandsIssued,
            promptsShown: ingestionLog.promptsShown,
          },
        },
      ];

      return buildResult(options, tasks, durationMs);
    }

    const graph = await options.ingestionAdapter.getMemoryGraph();
    const { overall, byType } = entityRecall(graph.entities, fixture.goldGraph.entities);

    const scores: Record<string, number> = {
      entity_recall: overall,
      ...byType,
    };

    const tasks: TaskResult[] = [
      {
        taskId: `entity-recall-${fixture.id}`,
        question: `Extract entities from ${fixture.id} fixture`,
        expected: `${fixture.goldGraph.entities.length} entities`,
        actual: `${graph.entities.length} entities extracted`,
        scores,
        latencyMs: durationMs,
        tokens: { input: 0, output: 0 },
        details: {
          fixtureId: fixture.id,
          goldEntityCount: fixture.goldGraph.entities.length,
          extractedEntityCount: graph.entities.length,
          ingestionErrors: ingestionLog.errors,
        },
      },
    ];

    return buildResult(options, tasks, durationMs);
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

async function buildResult(
  options: ResolvedRunBenchmarkOptions,
  tasks: TaskResult[],
  totalLatencyMs: number,
): Promise<BenchmarkResult> {
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
      remnicConfig: options.remnicConfig ?? {},
    },
    cost: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      totalLatencyMs,
      meanQueryLatencyMs: totalLatencyMs,
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
