/**
 * Ingestion backlink F1 benchmark.
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BenchmarkDefinition,
  BenchmarkResult,
  ResolvedRunBenchmarkOptions,
} from "../../../types.js";
import { backlinkF1 } from "../../../ingestion-scorer.js";
import { aggregateTaskScores, timed } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { emailFixture } from "../../../fixtures/inbox/email.js";

export const ingestionBacklinkF1Definition: BenchmarkDefinition = {
  id: "ingestion-backlink-f1",
  title: "Ingestion: Backlink F1",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ingestion-backlink-f1",
    version: "1.0.0",
    description: "Measures bidirectional-link extraction F1 against a curated gold graph after ingesting synthetic inbox data.",
    category: "ingestion",
  },
};

export async function runIngestionBacklinkF1Benchmark(
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

    const graph = await options.ingestionAdapter!.getMemoryGraph();
    const { precision, recall, f1 } = backlinkF1(graph.links, fixture.goldGraph.links);

    const scores: Record<string, number> = {
      backlink_precision: precision,
      backlink_recall: recall,
      backlink_f1: f1,
    };

    const tasks = [
      {
        taskId: `backlink-f1-${fixture.id}`,
        question: `Extract bidirectional links from ${fixture.id} fixture`,
        expected: `${fixture.goldGraph.links.length} links`,
        actual: `${graph.links.length} links extracted`,
        scores,
        latencyMs: durationMs,
        tokens: { input: 0, output: 0 },
        details: {
          fixtureId: fixture.id,
          goldLinkCount: fixture.goldGraph.links.length,
          extractedLinkCount: graph.links.length,
          ingestionErrors: ingestionLog.errors,
        },
      },
    ];

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
        totalLatencyMs: durationMs,
        meanQueryLatencyMs: durationMs,
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
  } finally {
    await rm(fixtureDir, { recursive: true, force: true });
  }
}
