/**
 * Ingestion setup friction benchmark.
 *
 * Counts commands issued, prompts shown, and errors produced during ingestion.
 * Lower setup_friction (commands + prompts) is better.
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
import { aggregateTaskScores, timed } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import { emailFixture } from "../../../fixtures/inbox/email.js";

/**
 * Metrics where a lower value represents better performance.
 * Pass this set to `compareResults` so regressions are detected correctly.
 */
export const INGESTION_SETUP_FRICTION_LOWER_IS_BETTER: ReadonlySet<string> =
  new Set(["setup_friction", "commands_count", "prompts_count", "errors_count"]);

export const ingestionSetupFrictionDefinition: BenchmarkDefinition = {
  id: "ingestion-setup-friction",
  title: "Ingestion: Setup Friction",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "ingestion-setup-friction",
    version: "1.0.0",
    description: "Counts commands and prompts required during ingestion. Lower setup_friction is better.",
    category: "ingestion",
  },
};

export async function runIngestionSetupFrictionBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  if (!options.ingestionAdapter) {
    throw new Error("ingestionAdapter is required for ingestion benchmarks");
  }
  const fixture = emailFixture.generate();

  const fixtureDir = await mkdtemp(path.join(tmpdir(), "bench-friction-"));
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

    const commandsCount = ingestionLog.commandsIssued.length;
    const promptsCount = ingestionLog.promptsShown.length;
    const errorsCount = ingestionLog.errors.length;
    const setupFriction = commandsCount + promptsCount;

    const scores: Record<string, number> = {
      setup_friction: setupFriction,
      commands_count: commandsCount,
      prompts_count: promptsCount,
      errors_count: errorsCount,
    };

    const tasks = [
      {
        taskId: `setup-friction-${fixture.id}`,
        question: `Measure setup friction for ${fixture.id} fixture`,
        expected: "0 commands, 0 prompts",
        actual: `${commandsCount} commands, ${promptsCount} prompts, ${errorsCount} errors`,
        scores,
        latencyMs: durationMs,
        tokens: { input: 0, output: 0 },
        details: {
          fixtureId: fixture.id,
          commandsIssued: ingestionLog.commandsIssued,
          promptsShown: ingestionLog.promptsShown,
          errors: ingestionLog.errors,
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
