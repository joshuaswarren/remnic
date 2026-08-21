/**
 * Ingestion schema completeness benchmark.
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
import { REQUIRED_FRONTMATTER_FIELDS } from "../../../ingestion-types.js";
import { schemaCompleteness } from "../../../ingestion-scorer.js";
import { aggregateTaskScores, timed } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { emailFixture } from "../../../fixtures/inbox/email.js";

export const ingestionSchemaCompletenessDefinition: BenchmarkDefinition = {
  id: "ingestion-schema-completeness",
  title: "Ingestion: Schema Completeness",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ingestion-schema-completeness",
    version: "1.0.0",
    description: "Measures frontmatter schema completeness of generated pages against the canonical required fields after ingesting synthetic inbox data.",
    category: "ingestion",
  },
};

export async function runIngestionSchemaCompletenessBenchmark(
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
          taskId: `schema-completeness-${fixture.id}`,
          question: `Check frontmatter schema completeness from ${fixture.id} fixture`,
          expected: `${fixture.goldGraph.pages.length} pages with required frontmatter fields`,
          actual: `(ingestion error: ${message})`,
          scores: {
            schema_completeness: -1,
          },
          latencyMs: durationMs,
          tokens: { input: 0, output: 0 },
          details: {
            fixtureId: fixture.id,
            goldPageCount: fixture.goldGraph.pages.length,
            ingestionErrors: ingestionLog.errors,
            commandsIssued: ingestionLog.commandsIssued,
            promptsShown: ingestionLog.promptsShown,
          },
        },
      ];
      options.onTaskComplete?.(tasks[0]!, 1, 1);

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
    }

    const graph = await options.ingestionAdapter.getMemoryGraph();
    const { overall, fieldCoverage } = schemaCompleteness(
      graph.pages,
      fixture.goldGraph.pages,
      REQUIRED_FRONTMATTER_FIELDS,
    );

    const perFieldScores: Record<string, number> = {};
    for (const [field, coverage] of Object.entries(fieldCoverage)) {
      const key = `field_${field.replace(/-/g, "_")}`;
      perFieldScores[key] = coverage;
    }

    const scores: Record<string, number> = {
      schema_completeness: overall,
      ...perFieldScores,
    };

    const tasks = [
      {
        taskId: `schema-completeness-${fixture.id}`,
        question: `Check frontmatter schema completeness from ${fixture.id} fixture`,
        expected: `${fixture.goldGraph.pages.length} pages with required frontmatter fields`,
        actual: `${graph.pages.length} pages extracted`,
        scores,
        latencyMs: durationMs,
        tokens: { input: 0, output: 0 },
        details: {
          fixtureId: fixture.id,
          goldPageCount: fixture.goldGraph.pages.length,
          extractedPageCount: graph.pages.length,
          fieldCoverage,
          ingestionErrors: ingestionLog.errors,
        },
      },
    ];
    options.onTaskComplete?.(tasks[0]!, 1, 1);

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
