/**
 * Deterministic benchmark for procedural recall gating (issue #519).
 */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  StorageManager,
  parseConfig,
  inferIntentFromText,
  isTaskInitiationIntent,
  buildProcedureRecallSection,
  buildProcedureMarkdownBody,
} from "@remnic/core";
import type { BenchmarkDefinition, BenchmarkResult, ResolvedRunBenchmarkOptions, TaskResult } from "../../../types.js";
import { aggregateTaskScores, exactMatch } from "../../../scorer.js";
import { getGitSha, getRemnicVersion } from "../../../reporter.js";
import {
  PROCEDURAL_RECALL_E2E_FIXTURE,
  PROCEDURAL_RECALL_E2E_SMOKE_FIXTURE,
  PROCEDURAL_RECALL_INTENT_FIXTURE,
  PROCEDURAL_RECALL_INTENT_SMOKE_FIXTURE,
} from "./fixture.js";

function sliceWithBudget<T>(cases: T[], budget: number): { picked: T[]; remaining: number } {
  if (!Number.isFinite(budget)) {
    return { picked: cases, remaining: Number.POSITIVE_INFINITY };
  }
  if (budget <= 0) {
    return { picked: [], remaining: 0 };
  }
  const n = Math.min(cases.length, Math.floor(budget));
  return { picked: cases.slice(0, n), remaining: budget - n };
}

export const proceduralRecallDefinition: BenchmarkDefinition = {
  id: "procedural-recall",
  title: "Procedural Recall",
  tier: "remnic",
  status: "ready",
  runnerAvailable: true,
  meta: {
    name: "procedural-recall",
    version: "1.0.0",
    description:
      "Task-initiation intent accuracy plus optional storage-backed procedure section assembly (issue #519).",
    category: "retrieval",
    citation: "Remnic internal synthetic benchmark for issue #519",
  },
};

export async function runProceduralRecallBenchmark(
  options: ResolvedRunBenchmarkOptions,
): Promise<BenchmarkResult> {
  const tasks: TaskResult[] = [];

  const intentSource =
    options.mode === "quick" ? PROCEDURAL_RECALL_INTENT_SMOKE_FIXTURE : PROCEDURAL_RECALL_INTENT_FIXTURE;
  const e2eSource =
    options.mode === "quick" ? PROCEDURAL_RECALL_E2E_SMOKE_FIXTURE : PROCEDURAL_RECALL_E2E_FIXTURE;

  const taskBudget =
    typeof options.limit === "number" && options.limit > 0 && Number.isFinite(options.limit)
      ? Math.floor(options.limit)
      : Number.POSITIVE_INFINITY;
  let remainingBudget = taskBudget;
  const intentPick = sliceWithBudget(intentSource, remainingBudget);
  const intentCases = intentPick.picked;
  remainingBudget = intentPick.remaining;
  const e2eCases = sliceWithBudget(e2eSource, remainingBudget).picked;
  const totalTasks = intentCases.length + e2eCases.length;

  for (const sample of intentCases) {
    const startedAt = performance.now();
    const intent = inferIntentFromText(sample.prompt);
    const actual = isTaskInitiationIntent(intent);
    const latencyMs = Math.round(performance.now() - startedAt);

    tasks.push({
      taskId: `intent:${sample.id}`,
      question: sample.prompt,
      expected: String(sample.expectTaskInit),
      actual: String(actual),
      scores: {
        task_initiation_gate: exactMatch(String(actual), String(sample.expectTaskInit)),
      },
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: { intent },
    });
    options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalTasks);
  }

  for (const sample of e2eCases) {
    const startedAt = performance.now();
    const dir = await mkdtemp(path.join(os.tmpdir(), "remnic-bench-procedural-recall-"));
    let section: string | null = null;
    try {
      const storage = new StorageManager(dir);
      await storage.ensureDirectories();
      const body = buildProcedureMarkdownBody(sample.procedureSteps);
      await storage.writeMemory(
        "procedure",
        `${sample.procedurePreamble}\n\n${body}`,
        { source: "bench", tags: sample.procedureTags },
      );

      const config = parseConfig({
        memoryDir: dir,
        workspaceDir: path.join(dir, "ws"),
        openaiApiKey: "bench-key",
        procedural: {
          enabled: sample.proceduralEnabled !== false,
          recallMaxProcedures: 3,
        },
      });

      section = await buildProcedureRecallSection(storage, sample.prompt, config);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const latencyMs = Math.round(performance.now() - startedAt);
    const nonNull = section !== null && section.length > 0;
    tasks.push({
      taskId: `e2e:${sample.id}`,
      question: sample.prompt,
      expected: String(sample.expectNonNullSection),
      actual: String(nonNull),
      scores: {
        procedure_section_gate: exactMatch(String(nonNull), String(sample.expectNonNullSection)),
      },
      latencyMs,
      tokens: { input: 0, output: 0 },
      details: { sectionPreview: section?.slice(0, 200) ?? null },
    });
    options.onTaskComplete?.(tasks[tasks.length - 1]!, tasks.length, totalTasks);
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
      aggregates: aggregateTaskScores(tasks.map((task) => task.scores)),
    },
    environment: {
      os: process.platform,
      nodeVersion: process.version,
      hardware: process.arch,
    },
  };
}
